package app.familiar.platform

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Attendees
import android.provider.CalendarContract.Reminders
import android.provider.CalendarContract.Instances
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId

/** CalendarProvider 持有数据；审批目标与执行快照必须相同，账本不自动重放未知写入。 */
object CalendarEditor {
    private val columns = arrayOf(Events._ID, Events.CALENDAR_ID, Events.TITLE, Events.DESCRIPTION, Events.EVENT_LOCATION,
        Events.DTSTART, Events.DTEND, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE, Events.RDATE,
        Events.DURATION, Events.EXRULE, Events.EXDATE, Events.ORIGINAL_ID, Events.ORIGINAL_SYNC_ID,
        Events.ORIGINAL_INSTANCE_TIME, Events.ORIGINAL_ALL_DAY, Events._SYNC_ID, Events.STATUS, Events.DELETED, Events.HAS_ALARM, Events.AVAILABILITY, Events.ACCESS_LEVEL, Events.ORGANIZER, Events.HAS_ATTENDEE_DATA)
    private data class Record(val row: ContentValues, val reminders: List<ContentValues>, val exceptions: List<Record> = emptyList(), val attendees: List<ContentValues> = emptyList()) {
        val id get() = row.getAsLong(Events._ID)
        val calendar get() = row.getAsLong(Events.CALENDAR_ID)
        val recurring get() = !row.getAsString(Events.RRULE).isNullOrEmpty() || !row.getAsString(Events.RDATE).isNullOrEmpty()
        val exception get() = row.getAsLong(Events.ORIGINAL_ID)!=null || !row.getAsString(Events.ORIGINAL_SYNC_ID).isNullOrEmpty()
        val revision: String get() = hash(canonical(JSONArray(listOf(rowJson(row), JSONArray(reminders.map { rowJson(it) }), JSONArray(exceptions.map { it.revision }), JSONArray(attendees.map { rowJson(it) })))))
        fun view(): JSONObject = JSONObject().put("eventId",id.toString()).put("calendarId",calendar.toString())
            .put("title",row.getAsString(Events.TITLE) ?: "").put("description",row.getAsString(Events.DESCRIPTION) ?: "")
            .put("location",row.getAsString(Events.EVENT_LOCATION) ?: "").put("start",Instant.ofEpochMilli(row.getAsLong(Events.DTSTART)).toString())
            .put("end",row.getAsLong(Events.DTEND)?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
            .put("timeZone",row.getAsString(Events.EVENT_TIMEZONE)).put("allDay",row.getAsInteger(Events.ALL_DAY)==1)
            .put("availability",row.getAsInteger(Events.AVAILABILITY) ?: 0).put("accessLevel",row.getAsInteger(Events.ACCESS_LEVEL) ?: 0).put("organizer",row.getAsString(Events.ORGANIZER) ?: "").put("attendees",JSONArray(attendees.map { rowJson(it) }))
            .put("isException",exception).put("cancelled",row.getAsInteger(Events.STATUS)==Events.STATUS_CANCELED)
            .put("seriesId",row.getAsLong(Events.ORIGINAL_ID)?.toString() ?: if(recurring) id.toString() else JSONObject.NULL)
            .put("originalStart",row.getAsLong(Events.ORIGINAL_INSTANCE_TIME)?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
            .put("recurring",recurring).put("recurrenceRule",row.getAsString(Events.RRULE) ?: "").put("recurrenceDates",row.getAsString(Events.RDATE) ?: "")
            .put("duration",row.getAsString(Events.DURATION) ?: "").put("reminders",JSONArray(reminders.map { JSONObject().put("minutes",it.getAsInteger(Reminders.MINUTES)).put("method",it.getAsInteger(Reminders.METHOD)) }))
            .put("exceptionRule",row.getAsString(Events.EXRULE) ?: "").put("exceptionDates",row.getAsString(Events.EXDATE) ?: "")
            .put("exceptions",JSONArray(exceptions.map { it.view() }))
            .put("target",JSONObject().put("eventId",id.toString()).put("revision",revision).put("title",row.getAsString(Events.TITLE) ?: "").put("start",Instant.ofEpochMilli(row.getAsLong(Events.DTSTART)).toString()).also { if(recurring) it.put("exceptionCount",exceptions.size) })
    }
    private fun check(context: Context, write: Boolean = false) {
        check(ContextCompat.checkSelfPermission(context,Manifest.permission.READ_CALENDAR)==PackageManager.PERMISSION_GRANTED) { "UNAVAILABLE" }
        if(write) check(ContextCompat.checkSelfPermission(context,Manifest.permission.WRITE_CALENDAR)==PackageManager.PERMISSION_GRANTED) { "UNAVAILABLE" }
    }
    private fun row(cursor: Cursor): ContentValues = ContentValues().apply {
        for(i in 0 until cursor.columnCount) when(cursor.getType(i)) {
            Cursor.FIELD_TYPE_NULL -> putNull(cursor.getColumnName(i))
            Cursor.FIELD_TYPE_INTEGER -> put(cursor.getColumnName(i),cursor.getLong(i))
            Cursor.FIELD_TYPE_FLOAT -> put(cursor.getColumnName(i),cursor.getDouble(i))
            else -> put(cursor.getColumnName(i),cursor.getString(i))
        }
    }
    private fun rowJson(value: ContentValues): JSONObject = JSONObject().also { result -> value.keySet().sorted().forEach { result.put(it,value.get(it) ?: JSONObject.NULL) } }
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun canonical(value: Any?): String = when(value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",","{","}") { JSONObject.quote(it)+":"+canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",","[","]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    private fun number(text: String): Long { require(text.matches(Regex("[0-9]{1,18}"))) { "INVALID_INPUT" };return text.toLong() }
    private fun exceptionSelection(old: Record): Pair<String,Array<String>> {
        val sync=old.row.getAsString(Events._SYNC_ID)
        return if(sync.isNullOrEmpty()) Pair("${Events.DELETED}=0 AND ${Events.CALENDAR_ID}=? AND ${Events.ORIGINAL_ID}=?",arrayOf(old.calendar.toString(),old.id.toString()))
        else Pair("${Events.DELETED}=0 AND ${Events.CALENDAR_ID}=? AND (${Events.ORIGINAL_ID}=? OR ${Events.ORIGINAL_SYNC_ID}=?)",arrayOf(old.calendar.toString(),old.id.toString(),sync))
    }
    private fun record(context: Context,id: Long,withExceptions: Boolean=true): Record? {
        val cursor = context.contentResolver.query(ContentUris.withAppendedId(Events.CONTENT_URI,id),columns,null,null,null) ?: throw IllegalStateException("UNAVAILABLE")
        val event = cursor.use { c -> if(c.moveToFirst() && c.getInt(c.getColumnIndexOrThrow(Events.DELETED))==0) row(c) else null } ?: return null
        val reminders = context.contentResolver.query(Reminders.CONTENT_URI,arrayOf(Reminders._ID,Reminders.EVENT_ID,Reminders.MINUTES,Reminders.METHOD),"${Reminders.EVENT_ID}=?",arrayOf(id.toString()),"${Reminders._ID} ASC")?.use { c -> buildList<ContentValues> { while(c.moveToNext()) { check(size<100) { "UNAVAILABLE" };add(row(c)) } } } ?: throw IllegalStateException("UNAVAILABLE")
        // 超大外部日程不截断后冒充完整可编辑记录；交由原日历应用处理。
        check((event.getAsString(Events.TITLE)?.length ?: 0)<=2000 && rowJson(event).toString().length<=100000) { "UNAVAILABLE" }
        val attendees=context.contentResolver.query(Attendees.CONTENT_URI,arrayOf(Attendees._ID,Attendees.EVENT_ID,Attendees.ATTENDEE_NAME,Attendees.ATTENDEE_EMAIL,Attendees.ATTENDEE_RELATIONSHIP,Attendees.ATTENDEE_TYPE,Attendees.ATTENDEE_STATUS),"${Attendees.EVENT_ID}=?",arrayOf(id.toString()),"${Attendees._ID} ASC")?.use { c -> buildList<ContentValues> { while(c.moveToNext()) { check(size<100) { "LIMIT" };add(row(c)) } } } ?: throw IllegalStateException("UNAVAILABLE")
        val base=Record(event,reminders,attendees=attendees)
        if(!withExceptions || !base.recurring || base.exception) return base
        val (selection,args)=exceptionSelection(base)
        val ids=context.contentResolver.query(Events.CONTENT_URI,arrayOf(Events._ID),selection,args,"${Events._ID} ASC")?.use { c -> buildList<Long> { while(c.moveToNext()) { check(size<50) { "UNAVAILABLE" };add(c.getLong(0)) } } } ?: throw IllegalStateException("UNAVAILABLE")
        val result=base.copy(exceptions=ids.map { record(context,it,false) ?: throw IllegalStateException("CONFLICT") })
        check(result.view().toString().toByteArray(Charsets.UTF_8).size<=200000) { "UNAVAILABLE" }
        return result
    }
    fun read(context: Context,params: JSONObject): JSONObject { check(context);return (record(context,number(params.getString("eventId"))) ?: throw IllegalStateException("NOT_FOUND")).view() }
    private fun ledger(context: Context) = AtomicFile(File(context.noBackupFilesDir,"calendar-edits.json"))
    private fun load(context: Context): JSONObject = ledger(context).let { check(it.baseFile.length()<=8*1024*1024) { "UNAVAILABLE" };if(it.baseFile.exists()) JSONObject(String(it.readFully(),Charsets.UTF_8)) else JSONObject() }
    private fun save(context: Context,state: JSONObject) { val bytes=state.toString().toByteArray(Charsets.UTF_8);check(bytes.size<=8*1024*1024) { "UNAVAILABLE" };val file=ledger(context);val stream=file.startWrite();try { stream.write(bytes);file.finishWrite(stream) } catch(e:Exception) {file.failWrite(stream);throw e} }
    private fun key(params: JSONObject,name: String="operationId") = params.getString(name).also { require(it.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "INVALID_INPUT" } }
    private fun unknown(id: String) = JSONObject().put("status","unknown").put("recoveryId",id).put("detail","结果未确认，请重新读取日历核查。不要换操作编号重复执行；原始资料已保留。")
    @Synchronized fun recovery(context: Context,params: JSONObject): JSONObject { check(context);return load(context).optJSONObject(key(params,"recoveryId"))?.optJSONObject("before") ?: throw IllegalStateException("NOT_FOUND") }
    private fun writable(context: Context,calendar: Long): ContentValues {
        val value=context.contentResolver.query(ContentUris.withAppendedId(Calendars.CONTENT_URI,calendar),arrayOf(Calendars.CALENDAR_ACCESS_LEVEL,Calendars.MAX_REMINDERS,Calendars.ALLOWED_REMINDERS,Calendars.OWNER_ACCOUNT,Calendars.ALLOWED_AVAILABILITY,Calendars.ALLOWED_ATTENDEE_TYPES),null,null,null)?.use { c -> if(c.moveToFirst()) row(c) else null }
        check(value!=null && value.getAsInteger(Calendars.CALENDAR_ACCESS_LEVEL)>=Calendars.CAL_ACCESS_CONTRIBUTOR) { "UNAVAILABLE" };return value
    }
    private fun assertions(old: Record): ArrayList<ContentProviderOperation> = arrayListOf<ContentProviderOperation>().apply {
        add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(Events.CONTENT_URI,old.id)).withValues(old.row).withExpectedCount(1).build())
        add(ContentProviderOperation.newAssertQuery(Reminders.CONTENT_URI).withSelection("${Reminders.EVENT_ID}=?",arrayOf(old.id.toString())).withExpectedCount(old.reminders.size).build())
        old.reminders.forEach { add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(Reminders.CONTENT_URI,it.getAsLong(Reminders._ID))).withValues(it).withExpectedCount(1).build()) }
        add(ContentProviderOperation.newAssertQuery(Attendees.CONTENT_URI).withSelection("${Attendees.EVENT_ID}=?",arrayOf(old.id.toString())).withExpectedCount(old.attendees.size).build())
        old.attendees.forEach { add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(Attendees.CONTENT_URI,it.getAsLong(Attendees._ID))).withValues(it).withExpectedCount(1).build()) }
        if(old.recurring && !old.exception) {
            val (selection,args)=exceptionSelection(old)
            add(ContentProviderOperation.newAssertQuery(Events.CONTENT_URI).withSelection(selection,args).withExpectedCount(old.exceptions.size).build())
            old.exceptions.forEach { addAll(assertions(it)) }
        }
    }
    private fun patch(old: Record,p: JSONObject): ContentValues {
        val allowed=setOf("title","description","location","start","end","timeZone","recurrence","availability","visibility");require(p.length()>0 && p.keys().asSequence().all { it in allowed }) { "INVALID_INPUT" }
        val result=ContentValues()
        if(p.has("availability")) { val map=mapOf("busy" to Events.AVAILABILITY_BUSY,"free" to Events.AVAILABILITY_FREE,"tentative" to Events.AVAILABILITY_TENTATIVE);result.put(Events.AVAILABILITY,map[p.getString("availability")] ?: throw IllegalArgumentException("INVALID_INPUT")) }
        if(p.has("visibility")) { val map=mapOf("default" to Events.ACCESS_DEFAULT,"private" to Events.ACCESS_PRIVATE,"public" to Events.ACCESS_PUBLIC);result.put(Events.ACCESS_LEVEL,map[p.getString("visibility")] ?: throw IllegalArgumentException("INVALID_INPUT")) }
        for((input,column,max) in listOf(Triple("title",Events.TITLE,200),Triple("description",Events.DESCRIPTION,6000),Triple("location",Events.EVENT_LOCATION,500))) if(p.has(input)) {
            require(p.get(input) is String) { "INVALID_INPUT" };val value=p.getString(input);require(value.length<=max && (input!="title" || value.isNotBlank())) { "INVALID_INPUT" };result.put(column,value)
        }
        if(listOf("start","end","timeZone","recurrence").any { p.has(it) }) {
            if(old.recurring) {
                // 重排系列不暗中抹掉此前单次改期、取消或外部排除规则。
                check(old.exceptions.isEmpty() && listOf(Events.RDATE,Events.EXDATE,Events.EXRULE).all { old.row.getAsString(it).isNullOrEmpty() }) { "UNAVAILABLE" }
                require(listOf("start","end","timeZone","recurrence").all { p.has(it) }) { "INVALID_INPUT" }
            } else require(!p.has("recurrence") && old.row.getAsLong(Events.DTEND)!=null) { "INVALID_INPUT" }
            val zoneName=p.optString("timeZone",old.row.getAsString(Events.EVENT_TIMEZONE));require(zoneName in ZoneId.getAvailableZoneIds()) { "INVALID_INPUT" };val zone=ZoneId.of(zoneName)
            val begin=if(p.has("start")) OffsetDateTime.parse(p.getString("start")) else Instant.ofEpochMilli(old.row.getAsLong(Events.DTSTART)).atZone(zone).toOffsetDateTime()
            val end=if(p.has("end")) OffsetDateTime.parse(p.getString("end")) else Instant.ofEpochMilli(old.row.getAsLong(Events.DTEND)).atZone(zone).toOffsetDateTime()
            val startMs=begin.toInstant().toEpochMilli();val endMs=end.toInstant().toEpochMilli()
            require(begin.nano==0 && end.nano==0 && startMs>=0 && endMs>startMs && endMs-startMs<=31L*86400000 && begin.offset in zone.rules.getValidOffsets(begin.toLocalDateTime()) && end.offset in zone.rules.getValidOffsets(end.toLocalDateTime())) { "INVALID_INPUT" }
            if(old.row.getAsInteger(Events.ALL_DAY)==1) require(zoneName=="UTC" && startMs%86400000==0L && endMs%86400000==0L) { "INVALID_INPUT" }
            result.put(Events.DTSTART,startMs);result.put(Events.DTEND,endMs);result.put(Events.EVENT_TIMEZONE,zoneName)
            if(old.recurring) {
                result.put(Events.RRULE,CalendarRecurrence.rule(p.getJSONObject("recurrence"),begin,zone,old.row.getAsInteger(Events.ALL_DAY)==1))
                result.put(Events.DURATION,duration(endMs-startMs,old.row.getAsInteger(Events.ALL_DAY)==1));result.putNull(Events.DTEND)
            }
        }
        return result
    }
    private fun duration(millis: Long,allDay: Boolean) = if(allDay) "P${millis/86400000}D" else "PT${millis/1000}S"
    private fun instanceEnd(context: Context,id: Long,start: Long): Long? {
        val uri=Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it,start);ContentUris.appendId(it,start+1) }.build()
        val cursor=context.contentResolver.query(uri,arrayOf(Instances.END),"${Instances.EVENT_ID}=? AND ${Instances.BEGIN}=? AND ${Events.DELETED}=0 AND (${Events.STATUS} IS NULL OR ${Events.STATUS}!=?)",arrayOf(id.toString(),start.toString(),Events.STATUS_CANCELED.toString()),null) ?: throw IllegalStateException("UNAVAILABLE")
        return cursor.use { c ->
            if(!c.moveToFirst()) null else c.getLong(0).also { check(!c.moveToNext()) { "UNAVAILABLE" } }
        }
    }
    private data class Occurrence(val series: Record,val original: Long,val event: Record,val existing: Boolean) {
        val start get() = event.row.getAsLong(Events.DTSTART)
        val end get() = event.row.getAsLong(Events.DTEND)
        val cancelled get() = event.row.getAsInteger(Events.STATUS)==Events.STATUS_CANCELED
        fun target(): JSONObject = JSONObject().put("seriesId",series.id.toString()).put("originalStart",Instant.ofEpochMilli(original).toString())
            .put("revision",series.revision).put("title",event.row.getAsString(Events.TITLE) ?: "")
            .put("start",Instant.ofEpochMilli(start).toString()).put("end",Instant.ofEpochMilli(end).toString())
            .put("timeZone",event.row.getAsString(Events.EVENT_TIMEZONE)).put("allDay",event.row.getAsInteger(Events.ALL_DAY)==1).put("cancelled",cancelled)
        fun view(): JSONObject = JSONObject().put("target",target()).put("eventId",event.id.toString()).put("isException",existing)
            .put("editable",!series.row.getAsString(Events._SYNC_ID).isNullOrEmpty() && !cancelled)
            .put("detail",if(series.row.getAsString(Events._SYNC_ID).isNullOrEmpty()) "系列尚无同步标识，单次变更请在日历应用处理或等待同步后重读。" else if(cancelled) "此单次已取消，恢复请在日历应用处理。" else "复制完整 target 后批准单次变更。")
            .put("description",event.row.getAsString(Events.DESCRIPTION) ?: "").put("location",event.row.getAsString(Events.EVENT_LOCATION) ?: "")
            .put("reminders",JSONArray(event.reminders.map { JSONObject().put("minutes",it.getAsInteger(Reminders.MINUTES)).put("method",it.getAsInteger(Reminders.METHOD)) }))
    }
    private fun occurrence(context: Context,series: Record,original: Long): Occurrence {
        check(series.recurring && !series.exception && series.row.getAsInteger(Events.STATUS)!=Events.STATUS_CANCELED && !series.row.getAsString(Events.RRULE).isNullOrEmpty()) { "UNAVAILABLE" }
        val matches=series.exceptions.filter { it.row.getAsLong(Events.ORIGINAL_INSTANCE_TIME)==original }
        check(matches.size<=1) { "UNAVAILABLE" }
        val existing=matches.firstOrNull()
        if(existing!=null) {
            check(!existing.recurring && existing.row.getAsLong(Events.DTEND)!=null) { "UNAVAILABLE" }
            return Occurrence(series,original,existing,true)
        }
        val end=instanceEnd(context,series.id,original) ?: throw IllegalStateException("NOT_FOUND")
        // 用 Provider 展开的这一次时间构造修改基准，不把系列起点误当作实例时间。
        val row=ContentValues(series.row).apply {
            put(Events.DTSTART,original);put(Events.DTEND,end)
            listOf(Events.RRULE,Events.RDATE,Events.EXDATE,Events.EXRULE,Events.DURATION).forEach { putNull(it) }
        }
        return Occurrence(series,original,Record(row,series.reminders,attendees=series.attendees),false)
    }
    private fun instanceStart(params: JSONObject): Long {
        val value=OffsetDateTime.parse(params.getString("originalStart"));val millis=value.toInstant().toEpochMilli()
        require(value.nano==0 && millis>=0) { "INVALID_INPUT" };return millis
    }
    fun readInstance(context: Context,params: JSONObject): JSONObject {
        check(context)
        val series=record(context,number(params.getString("seriesId"))) ?: throw IllegalStateException("NOT_FOUND")
        return occurrence(context,series,instanceStart(params)).view()
    }
    /** 单次变更只创建或更新一个例外；取消保留 STATUS_CANCELED，不删除后使原实例复现。 */
    @Synchronized fun changeInstance(context: Context,method: String,params: JSONObject): JSONObject {
        check(context,true);require(method in listOf("calendar.instance.update","calendar.instance.cancel")) { "INVALID_INPUT" }
        val operation=key(params);val digest=hash(method+"\n"+canonical(params));val state=load(context)
        state.optJSONObject(operation)?.let { require(it.getString("digest")==digest) { "INVALID_INPUT" };return it.optJSONObject("result") ?: unknown(operation) }
        val target=params.getJSONObject("target");val series=record(context,number(target.getString("seriesId"))) ?: throw IllegalStateException("NOT_FOUND")
        val old=occurrence(context,series,instanceStart(target))
        check(canonical(target)==canonical(old.target())) { "CONFLICT" }
        // AOSP 对无同步标识的例外只展开子记录，会丢失其余实例；不能写后声称仅改一次。
        if(series.row.getAsString(Events._SYNC_ID).isNullOrEmpty()) return JSONObject().put("status","unavailable").put("detail","系列尚无同步标识，未写入。请在日历应用处理，或等待同步后重新读取；仍支持整组修改和删除。")
        check(!old.cancelled) { "NOT_FOUND" };writable(context,series.calendar)
        val update=if(method=="calendar.instance.update") patch(old.event,params.getJSONObject("patch")) else ContentValues().apply { put(Events.STATUS,Events.STATUS_CANCELED) }
        val ops=assertions(series);val index=ops.size
        if(old.existing) ops.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Events.CONTENT_URI,old.event.id)).withValues(update).withExpectedCount(1).build())
        else {
            val desired=ContentValues(old.event.row).apply { putAll(update) }
            val start=desired.getAsLong(Events.DTSTART);val end=desired.getAsLong(Events.DTEND)
            require(end>start && end-start<=31L*86400000 && (end-start)%1000==0L) { "INVALID_INPUT" }
            val insert=ContentValues(update).apply {
                remove(Events.DTEND);put(Events.DTSTART,start);put(Events.DURATION,duration(end-start,desired.getAsInteger(Events.ALL_DAY)==1))
                put(Events.ORIGINAL_INSTANCE_TIME,old.original)
            }
            ops.add(ContentProviderOperation.newInsert(ContentUris.withAppendedId(Events.CONTENT_EXCEPTION_URI,series.id)).withValues(insert).build())
        }
        require(state.length()<10000) { "UNAVAILABLE" }
        val entry=JSONObject().put("digest",digest).put("method",method).put("before",JSONObject().put("series",series.view()).put("instance",old.view())).put("time",System.currentTimeMillis())
        state.put(operation,entry);save(context,state)
        try {
            val results=context.contentResolver.applyBatch(CalendarContract.AUTHORITY,ops)
            val id=if(old.existing) old.event.id else ContentUris.parseId(results[index].uri ?: return unknown(operation))
            val after=record(context,series.id) ?: return unknown(operation)
            val current=occurrence(context,after,old.original)
            val oldSiblings=series.exceptions.filter { !old.existing || it.id!=old.event.id }
            val siblings=after.exceptions.filter { it.id!=id }
            val unchanged=canonical(rowJson(series.row))==canonical(rowJson(after.row)) && canonical(JSONArray(series.reminders.map { rowJson(it) }))==canonical(JSONArray(after.reminders.map { rowJson(it) })) && oldSiblings.map { it.revision }==siblings.map { it.revision }
            val reminders=old.event.reminders.map { listOf(it.getAsInteger(Reminders.MINUTES),it.getAsInteger(Reminders.METHOD)) }.sortedBy { it.toString() }
            val copied=current.event.reminders.map { listOf(it.getAsInteger(Reminders.MINUTES),it.getAsInteger(Reminders.METHOD)) }.sortedBy { it.toString() }
            val desired=ContentValues(old.event.row).apply { putAll(update) }
            val fields=listOf(Events.TITLE,Events.DESCRIPTION,Events.EVENT_LOCATION,Events.DTSTART,Events.DTEND,Events.EVENT_TIMEZONE,Events.ALL_DAY,Events.AVAILABILITY,Events.ACCESS_LEVEL)
            val verified=current.existing && current.event.id==id && unchanged && reminders==copied && fields.all { desired.get(it)?.toString()==current.event.row.get(it)?.toString() } &&
                if(method=="calendar.instance.cancel") current.cancelled && instanceEnd(context,old.event.id,old.start)==null && instanceEnd(context,series.id,old.original)==null
                else !current.cancelled && instanceEnd(context,id,current.start)==current.end && instanceEnd(context,series.id,old.original)==null
            if(!verified) return unknown(operation)
            val result=JSONObject().put("status","completed").put("eventId",id.toString()).put("recoveryId",operation).put("instance",current.view())
            entry.put("result",result);save(context,state);return result
        } catch(_:Exception) { return unknown(operation) }
    }
    /** 所有快照断言先于写入；Provider 的批处理内修改，之后回读确定结果。 */
    @Synchronized fun change(context: Context,method: String,params: JSONObject): JSONObject {
        check(context,true);require(method in listOf("calendar.update","calendar.delete","calendar.reminders","calendar.attendees")) { "INVALID_INPUT" }
        val operation=key(params);val target=params.getJSONObject("target");val id=number(target.getString("eventId"));val revision=target.getString("revision");require(revision.matches(Regex("[a-f0-9]{64}"))) { "INVALID_INPUT" }
        val scope=params.getString("scope");require(scope in listOf("event","series")) { "INVALID_INPUT" }
        val digest=hash(method+"\n"+canonical(params));val state=load(context)
        state.optJSONObject(operation)?.let { require(it.getString("digest")==digest) { "INVALID_INPUT" };return it.optJSONObject("result") ?: unknown(operation) }
        val old=record(context,id) ?: throw IllegalStateException("NOT_FOUND")
        check(old.revision==revision && (old.row.getAsString(Events.TITLE) ?: "")==target.getString("title") && old.row.getAsLong(Events.DTSTART)==OffsetDateTime.parse(target.getString("start")).toInstant().toEpochMilli()) { "CONFLICT" }
        check(!old.exception) { "UNAVAILABLE" }
        check(method=="calendar.delete" || old.exceptions.isEmpty() || !old.row.getAsString(Events._SYNC_ID).isNullOrEmpty()) { "UNAVAILABLE" }
        if(old.recurring) require(target.opt("exceptionCount") is Number && target.getDouble("exceptionCount")==old.exceptions.size.toDouble()) { "INVALID_INPUT" }
        require(scope==if(old.recurring) "series" else "event") { "INVALID_INPUT" };val calendar=writable(context,old.calendar);val ops=assertions(old)
        var updates: ContentValues?=null;var wanted: List<Int>?=null;var reminderMethod=Reminders.METHOD_ALERT;var guests:List<ContentValues>?=null
        when(method) {
            "calendar.attendees" -> {
                check((old.row.getAsString(Events.ORGANIZER) ?: "").isEmpty() || old.row.getAsString(Events.ORGANIZER)==calendar.getAsString(Calendars.OWNER_ACCOUNT) || calendar.getAsInteger(Calendars.CALENDAR_ACCESS_LEVEL)>=Calendars.CAL_ACCESS_OWNER) { "UNAVAILABLE" }
                val a=params.getJSONArray("attendees");require(a.length()<=100) { "LIMIT" }
                val allowedTypes=calendar.getAsString(Calendars.ALLOWED_ATTENDEE_TYPES)?.split(',')?.mapNotNull {it.toIntOrNull()} ?: emptyList()
                guests=(0 until a.length()).map { n -> val g=a.getJSONObject(n);require(g.length()==4 && g.keys().asSequence().all {it in setOf("name","email","type","status")}) { "INVALID_INPUT" }
                    val email=g.getString("email");val name=g.getString("name");require(email.length<=320 && email.matches(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) && name.length<=200 && !name.contains('\n')) { "INVALID_INPUT" }
                    val type=mapOf("none" to Attendees.TYPE_NONE,"required" to Attendees.TYPE_REQUIRED,"optional" to Attendees.TYPE_OPTIONAL)[g.getString("type")] ?: throw IllegalArgumentException("INVALID_INPUT")
                    check(type in allowedTypes) { "UNAVAILABLE" };val status=mapOf("none" to Attendees.ATTENDEE_STATUS_NONE,"accepted" to Attendees.ATTENDEE_STATUS_ACCEPTED,"declined" to Attendees.ATTENDEE_STATUS_DECLINED,"invited" to Attendees.ATTENDEE_STATUS_INVITED,"tentative" to Attendees.ATTENDEE_STATUS_TENTATIVE)[g.getString("status")] ?: throw IllegalArgumentException("INVALID_INPUT")
                    ContentValues().apply {put(Attendees.EVENT_ID,id);put(Attendees.ATTENDEE_NAME,name);put(Attendees.ATTENDEE_EMAIL,email);put(Attendees.ATTENDEE_TYPE,type);put(Attendees.ATTENDEE_STATUS,status);put(Attendees.ATTENDEE_RELATIONSHIP,Attendees.RELATIONSHIP_ATTENDEE)} }
                require(guests.map {it.getAsString(Attendees.ATTENDEE_EMAIL).lowercase()}.distinct().size==guests.size) { "INVALID_INPUT" }
                ops.add(ContentProviderOperation.newDelete(Attendees.CONTENT_URI).withSelection("${Attendees.EVENT_ID}=? AND (${Attendees.ATTENDEE_RELATIONSHIP} IS NULL OR ${Attendees.ATTENDEE_RELATIONSHIP}!=?)",arrayOf(id.toString(),Attendees.RELATIONSHIP_ORGANIZER.toString())).build())
                guests.forEach {ops.add(ContentProviderOperation.newInsert(Attendees.CONTENT_URI).withValues(it).build())}
                ops.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Events.CONTENT_URI,id)).withValue(Events.HAS_ATTENDEE_DATA,1).withExpectedCount(1).build())
            }
            "calendar.update" -> { updates=patch(old,params.getJSONObject("patch"));ops.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Events.CONTENT_URI,id)).withValues(updates).withExpectedCount(1).build()) }
            "calendar.delete" -> {
                // 先移除例外再移除主记录，兼容本地与已同步日历的 Provider 删除规则。
                old.exceptions.forEach { ops.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(Events.CONTENT_URI,it.id)).withExpectedCount(1).build()) }
                ops.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(Events.CONTENT_URI,id)).withExpectedCount(1).build())
            }
            "calendar.reminders" -> {
                val minutes=params.getJSONArray("minutes");require(minutes.length()<=5) { "INVALID_INPUT" };wanted=(0 until minutes.length()).map { require(minutes.get(it) is Number && minutes.getDouble(it)==minutes.getInt(it).toDouble()) { "INVALID_INPUT" };minutes.getInt(it) }.sorted()
                require(wanted.distinct().size==wanted.size && wanted.all { it in 0..40320 }) { "INVALID_INPUT" };check(wanted.size<=(calendar.getAsInteger(Calendars.MAX_REMINDERS) ?: 0)) { "UNAVAILABLE" }
                val allowed=calendar.getAsString(Calendars.ALLOWED_REMINDERS)?.split(',')?.mapNotNull { it.trim().toIntOrNull() } ?: emptyList()
                if(params.has("method")) { reminderMethod=mapOf("default" to Reminders.METHOD_DEFAULT,"alert" to Reminders.METHOD_ALERT,"email" to Reminders.METHOD_EMAIL,"sms" to Reminders.METHOD_SMS)[params.getString("method")] ?: throw IllegalArgumentException("INVALID_INPUT") }
                else reminderMethod=if(Reminders.METHOD_ALERT in allowed) Reminders.METHOD_ALERT else Reminders.METHOD_DEFAULT
                check(wanted.isEmpty() || reminderMethod in allowed) { "UNAVAILABLE" }
                ops.add(ContentProviderOperation.newDelete(Reminders.CONTENT_URI).withSelection("${Reminders.EVENT_ID}=?",arrayOf(id.toString())).build())
                wanted.forEach { ops.add(ContentProviderOperation.newInsert(Reminders.CONTENT_URI).withValue(Reminders.EVENT_ID,id).withValue(Reminders.MINUTES,it).withValue(Reminders.METHOD,reminderMethod).build()) }
                ops.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Events.CONTENT_URI,id)).withValue(Events.HAS_ALARM,if(wanted.isEmpty()) 0 else 1).withExpectedCount(1).build())
            }
        }
        require(state.length()<10000) { "UNAVAILABLE" }
        val entry=JSONObject().put("digest",digest).put("method",method).put("before",old.view()).put("time",System.currentTimeMillis())
        state.put(operation,entry);save(context,state)
        try {
            context.contentResolver.applyBatch(CalendarContract.AUTHORITY,ops)
            val after=record(context,id)
            val verified=when(method) {
                "calendar.delete" -> after==null && old.exceptions.all { record(context,it.id,false)==null }
                "calendar.attendees" -> after!=null && after.attendees.filter {it.getAsInteger(Attendees.ATTENDEE_RELATIONSHIP)!=Attendees.RELATIONSHIP_ORGANIZER}.map {cv -> canonical(rowJson(ContentValues(cv).apply {remove(Attendees._ID)}))}.sorted()==guests!!.map {canonical(rowJson(it))}.sorted()
                "calendar.update" -> after!=null && updates!!.keySet().all { updates.get(it)?.toString()==after.row.get(it)?.toString() }
                else -> after!=null && after.reminders.map { it.getAsInteger(Reminders.MINUTES) }.sorted()==wanted && after.reminders.all { it.getAsInteger(Reminders.METHOD)==reminderMethod } && after.row.getAsInteger(Events.HAS_ALARM)==if(wanted!!.isEmpty()) 0 else 1
            }
            if(!verified) return unknown(operation)
            val result=JSONObject().put("status","completed").put("eventId",id.toString()).put("recoveryId",operation).put("event",after?.view() ?: JSONObject.NULL)
            if(method=="calendar.attendees") result.put("detail","已回读确认本地参会人记录；邀请是否发送和对方回复由日历账号及同步服务负责，未验证送达。")
            if(method=="calendar.reminders") result.put("detail","提醒记录已回读确认；实际通知由系统日历应用负责，未验证响铃。")
            entry.put("result",result);save(context,state);return result
        } catch(_:Exception) { return unknown(operation) }
    }
}
