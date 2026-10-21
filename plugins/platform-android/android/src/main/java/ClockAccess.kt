package app.familiar.platform

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import android.provider.AlarmClock
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** 使用公开 AlarmClock 协议交给用户的时钟应用；不读取厂商私有数据库，不把交接当作已创建。 */
object ClockAccess {
    private val actions = mapOf("alarm.set" to AlarmClock.ACTION_SET_ALARM, "alarm.dismiss" to AlarmClock.ACTION_DISMISS_ALARM,
        "alarm.snooze" to AlarmClock.ACTION_SNOOZE_ALARM, "timer.set" to AlarmClock.ACTION_SET_TIMER,
        "timer.dismiss" to AlarmClock.ACTION_DISMISS_TIMER, "show.alarms" to AlarmClock.ACTION_SHOW_ALARMS, "show.timers" to AlarmClock.ACTION_SHOW_TIMERS)
    fun status(context: Context): JSONObject {
        val supported = JSONObject(); actions.forEach { (key, action) -> supported.put(key, Intent(action).resolveActivity(context.packageManager) != null) }
        val next = context.getSystemService(AlarmManager::class.java).nextAlarmClock
        return JSONObject().put("supported", supported).put("nextAlarm", if (next == null) JSONObject.NULL else JSONObject().put("time", java.time.Instant.ofEpochMilli(next.triggerTime).toString()).put("packageName", next.showIntent?.creatorPackage ?: ""))
            .put("detail", "完整闹钟/计时器列表、编辑、启停、删除由时钟应用所有；先 show，再通过无障碍逐步操作和回看。dismiss 只解除本次响铃，不等于永久删除。")
    }
    fun ringtones(context: Context): JSONObject {
        val manager = RingtoneManager(context); manager.setType(RingtoneManager.TYPE_ALARM)
        val rows = JSONArray(); manager.cursor.use { c -> while(c.moveToNext() && rows.length()<100) rows.put(JSONObject().put("title",c.getString(RingtoneManager.TITLE_COLUMN_INDEX)).put("uri",manager.getRingtoneUri(c.position).toString())) }
        return JSONObject().put("ringtones",rows).put("default",RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM).toString()).put("silent",AlarmClock.VALUE_RINGTONE_SILENT)
    }
    private fun integer(p: JSONObject,key: String,min: Int,max: Int): Int { val v=p.get(key);require(v is Number && v.toDouble()==p.getInt(key).toDouble() && p.getInt(key) in min..max) { "INVALID_INPUT" };return p.getInt(key) }
    private fun label(p: JSONObject): String = p.getString("label").also { require(it.isNotBlank() && it.length<=200) { "INVALID_INPUT" } }
    @Synchronized fun call(context: Context,method: String,p: JSONObject): JSONObject {
        check(NativeLocation.interactive(context)) { "UNAVAILABLE" }
        val op=p.getString("operationId");require(op.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "INVALID_INPUT" }
        val kind=if(method=="clock.show") "show.${p.getString("view")}" else method.removePrefix("clock.")
        val action=actions[kind] ?: throw IllegalArgumentException("INVALID_INPUT")
        val intent=Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val allowed=when(kind) {
            "alarm.set" -> setOf("operationId","hour","minute","label","weekDays","vibrate","ringtone","skipUi")
            "alarm.dismiss" -> setOf("operationId","search","label","hour","minute")
            "alarm.snooze" -> setOf("operationId","durationMinutes")
            "timer.set" -> setOf("operationId","seconds","label","skipUi")
            "timer.dismiss" -> setOf("operationId")
            else -> setOf("operationId","view")
        }
        require(p.keys().asSequence().all { it in allowed }) { "INVALID_INPUT" }
        if(kind=="alarm.set") {
            intent.putExtra(AlarmClock.EXTRA_HOUR,integer(p,"hour",0,23)).putExtra(AlarmClock.EXTRA_MINUTES,integer(p,"minute",0,59)).putExtra(AlarmClock.EXTRA_MESSAGE,label(p))
            if(p.has("weekDays")) {
                val map=mapOf("SU" to 1,"MO" to 2,"TU" to 3,"WE" to 4,"TH" to 5,"FR" to 6,"SA" to 7);val days=p.getJSONArray("weekDays");require(days.length()<=7) { "INVALID_INPUT" }
                val values=(0 until days.length()).map { map[days.getString(it)] ?: throw IllegalArgumentException("INVALID_INPUT") };require(values.distinct().size==values.size) { "INVALID_INPUT" }
                intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS,ArrayList(values))
            }
            if(p.has("vibrate")) { require(p.get("vibrate") is Boolean) { "INVALID_INPUT" };intent.putExtra(AlarmClock.EXTRA_VIBRATE,p.getBoolean("vibrate")) }
            if(p.has("ringtone")) { val uri=p.getString("ringtone");require(uri.length<=2000 && (uri==AlarmClock.VALUE_RINGTONE_SILENT || Uri.parse(uri).scheme=="content" && Uri.parse(uri).authority in setOf("media","settings"))) { "INVALID_INPUT" };intent.putExtra(AlarmClock.EXTRA_RINGTONE,uri) }
        } else if(kind=="alarm.dismiss") {
            when(p.getString("search")) {
                "label" -> { require(!p.has("hour") && !p.has("minute")) { "INVALID_INPUT" };intent.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE,AlarmClock.ALARM_SEARCH_MODE_LABEL).putExtra(AlarmClock.EXTRA_MESSAGE,label(p)) }
                "time" -> { require(!p.has("label")) { "INVALID_INPUT" };val h=integer(p,"hour",0,23);intent.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE,AlarmClock.ALARM_SEARCH_MODE_TIME).putExtra(AlarmClock.EXTRA_HOUR,if(h%12==0) 12 else h%12).putExtra(AlarmClock.EXTRA_MINUTES,integer(p,"minute",0,59)).putExtra(AlarmClock.EXTRA_IS_PM,h>=12) }
                "next","all" -> { require(!p.has("hour") && !p.has("minute") && !p.has("label")) { "INVALID_INPUT" };intent.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE,if(p.getString("search")=="next") AlarmClock.ALARM_SEARCH_MODE_NEXT else AlarmClock.ALARM_SEARCH_MODE_ALL) }
                else -> throw IllegalArgumentException("INVALID_INPUT")
            }
        } else if(kind=="alarm.snooze") intent.putExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION,integer(p,"durationMinutes",1,1440))
        else if(kind=="timer.set") intent.putExtra(AlarmClock.EXTRA_LENGTH,integer(p,"seconds",1,86400)).putExtra(AlarmClock.EXTRA_MESSAGE,label(p))
        if(p.has("skipUi")) { require(p.get("skipUi") is Boolean) { "INVALID_INPUT" };intent.putExtra(AlarmClock.EXTRA_SKIP_UI,p.getBoolean("skipUi")) }
        check(intent.resolveActivity(context.packageManager)!=null) { "UNAVAILABLE" }
        val canonical=p.keys().asSequence().sorted().joinToString("|") { it+":"+p.get(it).toString() }
        val digest=MessageDigest.getInstance("SHA-256").digest((method+canonical).toByteArray()).joinToString("") { "%02x".format(it) }
        val file=AtomicFile(File(context.noBackupFilesDir,"clock-operations.json"));val journal=if(file.baseFile.exists()) JSONObject(String(file.readFully(),Charsets.UTF_8)) else JSONObject()
        val previous=journal.optJSONObject(op)
        if(previous!=null) { require(previous.getString("digest")==digest) { "INVALID_INPUT" };return previous.optJSONObject("result") ?: JSONObject().put("status","unknown").put("detail","交接结果未知；先观察时钟，不要改操作号重复提交。") }
        require(journal.length()<10000) { "UNAVAILABLE" }
        fun save() { val s=file.startWrite();try { s.write(journal.toString().toByteArray());file.finishWrite(s) } catch(e:Exception) { file.failWrite(s);throw e } }
        val record=JSONObject().put("digest",digest);journal.put(op,record);save()
        return try { context.startActivity(intent);val result=JSONObject().put("status","handedOff").put("operationId",op).put("detail","已交给系统时钟，尚未验证生效。请用 android_screen 观察，必要时继续操作或请用户确认。");record.put("result",result);save();result }
        catch(_:Exception) { JSONObject().put("status","unknown").put("detail","交接结果未知，请查看时钟。") }
    }
}
