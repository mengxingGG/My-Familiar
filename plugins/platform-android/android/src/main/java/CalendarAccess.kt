package app.familiar.platform

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract.Calendars as Calendars
import android.provider.CalendarContract.Events as Events
import android.provider.CalendarContract.Instances as Instances
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.ZoneId

/** CalendarProvider 是数据所有者；每次执行重新检查系统权限，不伪造本地日历。 */
object CalendarAccess {
    private fun check(context: Context, write: Boolean = false) {
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) { "UNAVAILABLE" }
        if (write) check(ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED) { "UNAVAILABLE" }
    }

    fun calendars(context: Context): JSONArray {
        check(context)
        val result = JSONArray()
        context.contentResolver.query(Calendars.CONTENT_URI, arrayOf(Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_ACCESS_LEVEL), "${Calendars.VISIBLE}=1", null, "${Calendars._ID} ASC")?.use { cursor ->
            while (cursor.moveToNext() && result.length() < 100) result.put(JSONObject()
                .put("id", cursor.getLong(0).toString()).put("name", cursor.getString(1))
                .put("writable", cursor.getInt(2) >= Calendars.CAL_ACCESS_CONTRIBUTOR))
        } ?: throw IllegalStateException("UNAVAILABLE")
        return result
    }

    fun query(context: Context, params: JSONObject): JSONObject {
        check(context)
        require(params.keys().asSequence().all {it in setOf("start","end","calendarId","query","offset")}) { "INVALID_INPUT" }
        val offset=if(params.has("offset")) params.getInt("offset") else 0
        require(offset in 0..10000 && (!params.has("offset") || params.get("offset") is Number && params.getDouble("offset")==offset.toDouble())) { "INVALID_INPUT" }
        val selections=mutableListOf("${Instances.VISIBLE}=1 AND ${Events.DELETED}=0 AND (${Events.STATUS} IS NULL OR ${Events.STATUS}!=${Events.STATUS_CANCELED})")
        val args=mutableListOf<String>()
        if(params.has("calendarId")) {val id=params.getString("calendarId");require(id.matches(Regex("[0-9]{1,18}"))) { "INVALID_INPUT" };selections.add("${Instances.CALENDAR_ID}=?");args.add(id)}
        if(params.has("query")) {val text=params.getString("query");require(text.length in 1..200) { "INVALID_INPUT" };selections.add("(instr(lower(COALESCE(${Events.TITLE},'')),lower(?))>0 OR instr(lower(COALESCE(${Events.DESCRIPTION},'')),lower(?))>0 OR instr(lower(COALESCE(${Events.EVENT_LOCATION},'')),lower(?))>0)");repeat(3){args.add(text)}}
        val start = OffsetDateTime.parse(params.getString("start")).toInstant().toEpochMilli()
        val end = OffsetDateTime.parse(params.getString("end")).toInstant().toEpochMilli()
        require(start >= 0 && end > start && end - start <= 31L * 86400000) { "INVALID_INPUT" }
        val uri = Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, start); ContentUris.appendId(it, end) }.build()
        val result = JSONArray()
        var truncated = false
        var skipped = 0
        context.contentResolver.query(uri, arrayOf(Instances.EVENT_ID, Instances.CALENDAR_ID, Instances.TITLE, Instances.BEGIN, Instances.END, Instances.EVENT_LOCATION, Instances.ALL_DAY, Instances.EVENT_TIMEZONE, Events.ORIGINAL_ID, Events.ORIGINAL_INSTANCE_TIME, Events.RRULE, Events.RDATE), selections.joinToString(" AND "), args.toTypedArray(), "${Instances.BEGIN} ASC, ${Instances.EVENT_ID} ASC")?.use { cursor ->
            while (cursor.moveToNext()) {
                if(skipped++ < offset) continue
                if (result.length() >= 100) { truncated = true; break }
                result.put(JSONObject().put("id", cursor.getLong(0).toString()).put("calendarId", cursor.getLong(1).toString())
                    .put("title", cursor.getString(2)).put("start", java.time.Instant.ofEpochMilli(cursor.getLong(3)).toString())
                    .put("end", java.time.Instant.ofEpochMilli(cursor.getLong(4)).toString()).put("location", cursor.getString(5) ?: "")
                    .put("allDay", cursor.getInt(6) != 0).put("timeZone", cursor.getString(7)).also { item ->
                        val recurring=!cursor.getString(10).isNullOrEmpty() || !cursor.getString(11).isNullOrEmpty()
                        if(!cursor.isNull(8) || recurring) {
                            item.put("seriesId",cursor.getLong(if(cursor.isNull(8)) 0 else 8).toString())
                            item.put("originalStart",java.time.Instant.ofEpochMilli(cursor.getLong(if(cursor.isNull(9)) 3 else 9)).toString())
                        }
                    })
            }
        } ?: throw IllegalStateException("UNAVAILABLE")
        return JSONObject().put("events", result).put("truncated", truncated).put("nextOffset",if(truncated) offset+100 else JSONObject.NULL)
    }

    private fun journal(context: Context) = AtomicFile(File(context.noBackupFilesDir, "calendar-operations.json"))
    private fun readJournal(context: Context): JSONObject {
        val file = journal(context)
        if (!file.baseFile.exists()) return JSONObject()
        // 账本损坏时拒绝继续写，不能把它当成空账本重复创建日程。
        return JSONObject(String(file.readFully(), Charsets.UTF_8))
    }
    private fun saveJournal(context: Context, state: JSONObject) {
        val file = journal(context)
        val stream = file.startWrite()
        try { stream.write(state.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    private fun unknown() = JSONObject().put("status", "unknown").put("detail", "本次日程写入结果未能确认，请查询日历核实，不要改用新操作编号重复创建。")

    /** 先记操作号、再写系统日历；中断后同一操作不会自动重放。 */
    @Synchronized fun create(context: Context, params: JSONObject): JSONObject {
        check(context, true)
        require(params.keys().asSequence().all { it in setOf("operationId", "calendarId", "title", "description", "location", "start", "end", "timeZone", "allDay", "recurrence") }) { "INVALID_INPUT" }
        for (field in listOf("operationId", "calendarId", "title", "start", "end", "timeZone")) require(params.get(field) is String) { "INVALID_INPUT" }
        for (field in listOf("description", "location")) if (params.has(field)) require(params.get(field) is String) { "INVALID_INPUT" }
        require(!params.has("allDay") || params.get("allDay") is Boolean) { "INVALID_INPUT" }
        require(!params.has("recurrence") || params.get("recurrence") is JSONObject) { "INVALID_INPUT" }
        val key = params.getString("operationId")
        require(key.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "INVALID_INPUT" }
        require(params.getString("calendarId").matches(Regex("[0-9]{1,18}"))) { "INVALID_INPUT" }
        val calendar = params.getString("calendarId").toLong()
        val title = params.getString("title").trim()
        val description = params.optString("description", "")
        val location = params.optString("location", "")
        val start = OffsetDateTime.parse(params.getString("start"))
        val end = OffsetDateTime.parse(params.getString("end"))
        val zoneName = params.getString("timeZone")
        require(zoneName in ZoneId.getAvailableZoneIds()) { "INVALID_INPUT" }
        val zone = ZoneId.of(zoneName)
        val begin = start.toInstant().toEpochMilli()
        val finish = end.toInstant().toEpochMilli()
        require(title.isNotEmpty() && title.length <= 200 && description.length <= 6000 && location.length <= 500 && begin >= 0 && finish > begin && finish - begin <= 31L * 86400000) { "INVALID_INPUT" }
        require(start.offset in zone.rules.getValidOffsets(start.toLocalDateTime()) && end.offset in zone.rules.getValidOffsets(end.toLocalDateTime())) { "INVALID_INPUT" }
        val allDay = params.optBoolean("allDay", false)
        if (allDay) require(zoneName == "UTC" && begin % 86400000 == 0L && finish % 86400000 == 0L && start.nano == 0 && end.nano == 0) { "INVALID_INPUT" }
        val rule = params.optJSONObject("recurrence")?.let {
            require(start.nano == 0 && end.nano == 0) { "INVALID_INPUT" }
            CalendarRecurrence.rule(it, start, zone, allDay)
        }
        val duration = if (rule == null) null else if (allDay) "P${(finish-begin)/86400000}D" else "PT${(finish-begin)/1000}S"
        // 普通定时日程沿用旧摘要，升级前完成的操作号仍能防重。
        val identity = JSONArray(listOf(calendar, title, description, location, begin, finish, zoneName))
        if (allDay || rule != null) identity.put(JSONArray(listOf("calendar-create-v2", allDay, rule, duration)))
        val digest = MessageDigest.getInstance("SHA-256").digest(identity.toString().toByteArray()).joinToString("") { "%02x".format(it) }
        val state = readJournal(context)
        state.optJSONObject(key)?.let { previous ->
            require(previous.getString("digest") == digest) { "INVALID_INPUT" }
            return previous.optJSONObject("result") ?: unknown()
        }
        require(state.length() < 10000) { "UNAVAILABLE" }
        val writable = context.contentResolver.query(ContentUris.withAppendedId(Calendars.CONTENT_URI, calendar), arrayOf(Calendars.CALENDAR_ACCESS_LEVEL), null, null, null)?.use { cursor -> cursor.moveToFirst() && cursor.getInt(0) >= Calendars.CAL_ACCESS_CONTRIBUTOR } ?: false
        check(writable) { "UNAVAILABLE" }
        val record = JSONObject().put("digest", digest)
        state.put(key, record)
        saveJournal(context, state)
        try {
            val uri = context.contentResolver.insert(Events.CONTENT_URI, ContentValues().apply {
                put(Events.CALENDAR_ID, calendar); put(Events.TITLE, title); put(Events.DESCRIPTION, description); put(Events.EVENT_LOCATION, location)
                put(Events.DTSTART, begin); put(Events.EVENT_TIMEZONE, zoneName); put(Events.ALL_DAY, if (allDay) 1 else 0)
                if (rule == null) put(Events.DTEND, finish)
                else { put(Events.RRULE, rule); put(Events.DURATION, duration) }
            }) ?: return unknown()
            val verified = context.contentResolver.query(uri, arrayOf(Events.CALENDAR_ID, Events.TITLE, Events.DTSTART, Events.DTEND, Events.DESCRIPTION, Events.EVENT_LOCATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE, Events.DURATION), null, null, null)?.use { cursor ->
                cursor.moveToFirst() && cursor.getLong(0) == calendar && cursor.getString(1) == title && cursor.getLong(2) == begin &&
                    (if (rule == null) cursor.getLong(3) == finish && cursor.isNull(9) else cursor.isNull(3) && cursor.getString(9) == duration) &&
                    (cursor.getString(4) ?: "") == description && (cursor.getString(5) ?: "") == location && cursor.getString(6) == zoneName &&
                    cursor.getInt(7) == (if (allDay) 1 else 0) && (cursor.getString(8) ?: "") == (rule ?: "")
            } ?: false
            if (!verified) return unknown()
            val result = JSONObject().put("status", "completed").put("eventId", ContentUris.parseId(uri).toString()).put("title", title)
                .put("start", start.toString()).put("end", end.toString()).put("timeZone", zoneName).put("allDay", allDay)
                .put("recurrenceRule", rule ?: "").put("duration", duration ?: "")
            record.put("result", result)
            saveJournal(context, state)
            return result
        } catch (_: Exception) { return unknown() }
    }
}
