package app.familiar.platform

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.ZoneId

/** 本地日历使用官方 ACCOUNT_TYPE_LOCAL 协议；绝不以同步身份修改其他账号。 */
object CalendarDirectory {
    private val columns=arrayOf(Calendars.NAME,Calendars.SYNC_EVENTS,Calendars._ID,Calendars.CALENDAR_DISPLAY_NAME,Calendars.CALENDAR_COLOR,Calendars.CALENDAR_TIME_ZONE,Calendars.VISIBLE,Calendars.CALENDAR_ACCESS_LEVEL,Calendars.ACCOUNT_NAME,Calendars.ACCOUNT_TYPE,Calendars.OWNER_ACCOUNT,Calendars.MAX_REMINDERS,Calendars.ALLOWED_REMINDERS,Calendars.ALLOWED_AVAILABILITY,Calendars.ALLOWED_ATTENDEE_TYPES)
    private fun checkPermission(context:Context,write:Boolean=false) { check(ContextCompat.checkSelfPermission(context,Manifest.permission.READ_CALENDAR)==PackageManager.PERMISSION_GRANTED && (!write || ContextCompat.checkSelfPermission(context,Manifest.permission.WRITE_CALENDAR)==PackageManager.PERMISSION_GRANTED)) { "UNAVAILABLE" } }
    private fun account(context:Context)="${context.packageName}.local"
    private fun owned(context:Context,row:JSONObject)=row.optString(Calendars.ACCOUNT_NAME)==account(context) && row.optString(Calendars.ACCOUNT_TYPE)==CalendarContract.ACCOUNT_TYPE_LOCAL
    private fun hash(text:String)=MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun read(context:Context,id:Long):JSONObject? = context.contentResolver.query(ContentUris.withAppendedId(Calendars.CONTENT_URI,id),columns,null,null,null)?.use { c -> if(!c.moveToFirst()) null else JSONObject().also { j -> columns.forEachIndexed { n,k -> j.put(k,if(c.isNull(n)) JSONObject.NULL else c.getString(n)) } } }
    private fun eventIds(context:Context,id:Long):List<Long> = context.contentResolver.query(Events.CONTENT_URI,arrayOf(Events._ID),"${Events.CALENDAR_ID}=? AND ${Events.DELETED}=0",arrayOf(id.toString()),"${Events._ID} ASC")?.use { c -> buildList { while(c.moveToNext()) { check(size<100000) { "LIMIT" };add(c.getLong(0)) } } } ?: throw IllegalStateException("UNAVAILABLE")
    private fun target(context:Context,row:JSONObject):JSONObject { val ids=eventIds(context,row.getLong(Calendars._ID));return JSONObject().put("calendarId",row.getString(Calendars._ID)).put("name",row.optString(Calendars.CALENDAR_DISPLAY_NAME)).put("eventCount",ids.size).put("revision",hash(columns.joinToString("|"){ row.optString(it) }+":"+ids.joinToString(","))) }
    private fun view(context:Context,row:JSONObject):JSONObject = JSONObject().put("id",row.getString(Calendars._ID)).put("name",row.optString(Calendars.CALENDAR_DISPLAY_NAME)).put("color",String.format("#%06X",row.optInt(Calendars.CALENDAR_COLOR) and 0xFFFFFF)).put("timeZone",row.optString(Calendars.CALENDAR_TIME_ZONE)).put("visible",row.optInt(Calendars.VISIBLE)==1).put("writable",row.optInt(Calendars.CALENDAR_ACCESS_LEVEL)>=Calendars.CAL_ACCESS_CONTRIBUTOR).put("owned",owned(context,row)).put("accountName",row.optString(Calendars.ACCOUNT_NAME)).put("accountType",row.optString(Calendars.ACCOUNT_TYPE)).put("owner",row.optString(Calendars.OWNER_ACCOUNT)).put("maxReminders",row.optInt(Calendars.MAX_REMINDERS)).put("allowedReminders",row.optString(Calendars.ALLOWED_REMINDERS)).put("allowedAvailability",row.optString(Calendars.ALLOWED_AVAILABILITY)).put("allowedAttendeeTypes",row.optString(Calendars.ALLOWED_ATTENDEE_TYPES)).put("target",target(context,row))
    fun list(context:Context,p:JSONObject):JSONArray {
        checkPermission(context);require(p.keys().asSequence().all { it=="includeHidden" } && (!p.has("includeHidden") || p.get("includeHidden") is Boolean)) { "INVALID_INPUT" }
        val ids=context.contentResolver.query(Calendars.CONTENT_URI,arrayOf(Calendars._ID),if(p.optBoolean("includeHidden")) null else "${Calendars.VISIBLE}=1",null,"${Calendars._ID} ASC")?.use { c -> buildList<Long> { while(c.moveToNext()) { check(size<100) { "LIMIT" };add(c.getLong(0)) } } } ?: throw IllegalStateException("UNAVAILABLE")
        return JSONArray(ids.map { view(context,read(context,it) ?: throw IllegalStateException("CONFLICT")) })
    }
    private fun fields(p:JSONObject):ContentValues {
        require(p.length()>0 && p.keys().asSequence().all { it in setOf("name","color","timeZone","visible") }) { "INVALID_INPUT" }
        return ContentValues().apply {
            if(p.has("name")) { val name=p.getString("name");require(name.isNotBlank() && name.length<=200) { "INVALID_INPUT" };put(Calendars.CALENDAR_DISPLAY_NAME,name) }
            if(p.has("color")) { val color=p.getString("color");require(color.matches(Regex("#[a-fA-F0-9]{6}"))) { "INVALID_INPUT" };put(Calendars.CALENDAR_COLOR,Color.parseColor(color)) }
            if(p.has("timeZone")) { val zone=p.getString("timeZone");require(zone in ZoneId.getAvailableZoneIds()) { "INVALID_INPUT" };put(Calendars.CALENDAR_TIME_ZONE,zone) }
            if(p.has("visible")) { require(p.get("visible") is Boolean) { "INVALID_INPUT" };put(Calendars.VISIBLE,if(p.getBoolean("visible")) 1 else 0) }
        }
    }
    private fun ownedUri(context:Context,id:Long?=null)= (if(id==null) Calendars.CONTENT_URI else ContentUris.withAppendedId(Calendars.CONTENT_URI,id)).buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER,"true").appendQueryParameter(Calendars.ACCOUNT_NAME,account(context)).appendQueryParameter(Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL).build()
    @Synchronized fun change(context:Context,method:String,p:JSONObject):JSONObject {
        checkPermission(context,true)
        val op=p.getString("operationId");require(op.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "INVALID_INPUT" }
        val canonical=p.keys().asSequence().sorted().joinToString("|"){it+":"+p.get(it)};val digest=hash(method+canonical)
        val file=AtomicFile(File(context.noBackupFilesDir,"calendar-directories.json"));check(file.baseFile.length()<4*1024*1024) { "LIMIT" };val ledger=if(file.baseFile.exists()) JSONObject(String(file.readFully(),Charsets.UTF_8)) else JSONObject()
        fun unknown()=JSONObject().put("status","unknown").put("detail","日历操作结果未确认，先 list(includeHidden=true) 核实，不换操作号重试。")
        ledger.optJSONObject(op)?.let { require(it.getString("digest")==digest) { "INVALID_INPUT" };return it.optJSONObject("result") ?: unknown() }
        require(ledger.length()<10000) { "LIMIT" }
        var id:Long?=null;var old:JSONObject?=null;var update:ContentValues?=null
        if(method=="calendar.local.create") { require(p.keys().asSequence().all { it in setOf("operationId","name","color","timeZone","visible") }) { "INVALID_INPUT" };val f=JSONObject(p.toString()).apply { remove("operationId") };for(k in listOf("name","color","timeZone")) require(f.has(k)) { "INVALID_INPUT" };update=fields(f) }
        else {
            require(method in setOf("calendar.settings.update","calendar.local.delete")) { "INVALID_INPUT" }
            val t=p.getJSONObject("target");id=t.getString("calendarId").toLong();old=read(context,id) ?: throw IllegalStateException("NOT_FOUND")
            require(t.length()==4 && t.getString("name")==old.optString(Calendars.CALENDAR_DISPLAY_NAME) && t.getString("revision")==target(context,old).getString("revision") && t.getInt("eventCount")==target(context,old).getInt("eventCount")) { "CONFLICT" }
            check(old.optInt(Calendars.CALENDAR_ACCESS_LEVEL)>=Calendars.CAL_ACCESS_OWNER || owned(context,old)) { "UNAVAILABLE" }
            if(method=="calendar.local.delete") { check(owned(context,old)) { "UNAVAILABLE" };require(p.length()==2) { "INVALID_INPUT" } }
            else { require(p.length()==3) { "INVALID_INPUT" };update=fields(p.getJSONObject("patch")) }
        }
        val record=JSONObject().put("digest",digest);ledger.put(op,record)
        fun save() { val s=file.startWrite();try { s.write(ledger.toString().toByteArray());file.finishWrite(s) } catch(e:Exception) {file.failWrite(s);throw e} };save()
        return try {
            if(method=="calendar.local.create") {
                val values=update!!;values.put(Calendars.ACCOUNT_NAME,account(context));values.put(Calendars.ACCOUNT_TYPE,CalendarContract.ACCOUNT_TYPE_LOCAL);values.put(Calendars.OWNER_ACCOUNT,account(context));values.put(Calendars.NAME,"familiar-$op");values.put(Calendars.CALENDAR_ACCESS_LEVEL,Calendars.CAL_ACCESS_OWNER);values.put(Calendars.SYNC_EVENTS,1);if(!values.containsKey(Calendars.VISIBLE)) values.put(Calendars.VISIBLE,1);values.put(Calendars.MAX_REMINDERS,5);values.put(Calendars.ALLOWED_REMINDERS,"0,1");values.put(Calendars.ALLOWED_AVAILABILITY,"0,1,2");values.put(Calendars.ALLOWED_ATTENDEE_TYPES,"0,1,2")
                id=ContentUris.parseId(context.contentResolver.insert(ownedUri(context),values) ?: return unknown())
            } else {
                val assertions=ContentValues().apply { columns.forEach { k -> if(old!!.isNull(k)) putNull(k) else put(k,old!!.getString(k)) } }
                val ops=arrayListOf(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(Calendars.CONTENT_URI,id!!)).withValues(assertions).withExpectedCount(1).build(),ContentProviderOperation.newAssertQuery(Events.CONTENT_URI).withSelection("${Events.CALENDAR_ID}=? AND ${Events.DELETED}=0",arrayOf(id.toString())).withExpectedCount(p.getJSONObject("target").getInt("eventCount")).build())
                if(method=="calendar.local.delete") ops.add(ContentProviderOperation.newDelete(ownedUri(context,id)).withExpectedCount(1).build())
                else ops.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Calendars.CONTENT_URI,id)).withValues(update!!).withExpectedCount(1).build())
                context.contentResolver.applyBatch(CalendarContract.AUTHORITY,ops)
            }
            val after=read(context,id!!)
            if(method=="calendar.local.delete") { if(after!=null || eventIds(context,id).isNotEmpty()) return unknown() }
            else if(after==null || update!!.keySet().any { update.get(it)?.toString()!=after.opt(it)?.toString() }) return unknown()
            val result=JSONObject().put("status","completed").put("calendarId",id.toString()).put("calendar",after?.let {view(context,it)} ?: JSONObject.NULL);record.put("result",result);save();result
        } catch(_:Exception) { unknown() }
    }
    @Synchronized fun open(context:Context,p:JSONObject):JSONObject {
        check(NativeLocation.interactive(context)) { "UNAVAILABLE" };val mode=p.getString("mode");require(mode in setOf("view","edit","insert")) { "INVALID_INPUT" }
        val intent=if(mode=="insert") { require(!p.has("eventId")) { "INVALID_INPUT" };Intent(Intent.ACTION_INSERT).setData(Events.CONTENT_URI) }
        else { checkPermission(context);val id=p.getString("eventId");require(id.matches(Regex("[0-9]{1,18}"))) { "INVALID_INPUT" };Intent(if(mode=="edit") Intent.ACTION_EDIT else Intent.ACTION_VIEW).setData(ContentUris.withAppendedId(Events.CONTENT_URI,id.toLong())) }
        check(intent.resolveActivity(context.packageManager)!=null) { "UNAVAILABLE" };context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return JSONObject().put("status","handedOff").put("detail","已打开系统日历，保存与同步状态尚未确认，请回读核实。")
    }
}
