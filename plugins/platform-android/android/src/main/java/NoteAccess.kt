package app.familiar.platform

import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.PowerManager
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** 官方 NoteIntents 支持正文；Android CREATE_NOTE 只约定打开编辑界面。 */
object NoteAccess {
    private const val PREFILLED = "com.google.android.gms.actions.CREATE_NOTE"
    private const val BLANK = "android.intent.action.CREATE_NOTE"
    private fun intent(mode: String) = when(mode) {
        "prefilled" -> Intent(PREFILLED).setType("text/plain")
        "blank" -> Intent(BLANK)
        else -> throw IllegalArgumentException("INVALID_INPUT")
    }
    fun targets(context: Context): JSONArray {
        val targets = JSONArray()
        for(mode in listOf("prefilled","blank")) {
            val receivers = context.packageManager.queryIntentActivities(intent(mode), PackageManager.MATCH_DEFAULT_ONLY)
            for(receiver in receivers.sortedBy { it.activityInfo.packageName+"/"+it.activityInfo.name }) {
                val activity = receiver.activityInfo
                if(!activity.exported || !activity.enabled || !activity.applicationInfo.enabled || activity.packageName==context.packageName) continue
                if(activity.permission!=null && context.checkSelfPermission(activity.permission)!=PackageManager.PERMISSION_GRANTED) continue
                if(targets.length()>=100) break
                targets.put(JSONObject().put("component",ComponentName(activity.packageName,activity.name).flattenToString())
                    .put("label",receiver.loadLabel(context.packageManager).toString().take(200)).put("mode",mode))
            }
        }
        return targets
    }
    private fun ledger(context: Context) = AtomicFile(File(context.noBackupFilesDir,"note-handoffs.json"))
    private fun save(context: Context,state: JSONObject) {
        val file=ledger(context);val stream=file.startWrite()
        try { stream.write(state.toString().toByteArray(Charsets.UTF_8));file.finishWrite(stream) }
        catch(e:Exception) { file.failWrite(stream);throw e }
    }
    private fun unknown() = JSONObject().put("status","unknown").put("saved",false).put("detail","笔记交接结果未确认，请检查目标应用，不要自动重复创建。")
    @Synchronized fun compose(context: Context,params: JSONObject): JSONObject {
        val operation=params.getString("operationId");require(operation.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "INVALID_INPUT" }
        val target=params.getJSONObject("target");val component=target.getString("component");val label=target.getString("label");val mode=target.getString("mode")
        val title=params.getString("title");val text=params.getString("text")
        require(title.length<=200 && text.length<=10000 && component.length<=500 && label.length<=200 && mode in listOf("prefilled","blank")) { "INVALID_INPUT" }
        require(if(mode=="blank") title.isEmpty() && text.isEmpty() else title.isNotBlank() || text.isNotBlank()) { "INVALID_INPUT" }
        val digest=MessageDigest.getInstance("SHA-256").digest(JSONArray(listOf(component,label,mode,title,text)).toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val file=ledger(context);val state=if(file.baseFile.exists()) JSONObject(String(file.readFully(),Charsets.UTF_8)) else JSONObject()
        state.optJSONObject(operation)?.let { require(it.getString("digest")==digest) { "INVALID_INPUT" };return it.optJSONObject("result") ?: unknown() }
        val available=targets(context)
        check((0 until available.length()).any { val found=available.getJSONObject(it);found.getString("component")==component && found.getString("label")==label && found.getString("mode")==mode }) { "UNAVAILABLE" }
        check(!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked && context.getSystemService(PowerManager::class.java).isInteractive) { "UNAVAILABLE" }
        val request=intent(mode).setComponent(ComponentName.unflattenFromString(component)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if(mode=="prefilled") request.putExtra("com.google.android.gms.actions.extra.NAME",title).putExtra("com.google.android.gms.actions.extra.TEXT",text)
        check(state.length()<10000) { "UNAVAILABLE" }
        val entry=JSONObject().put("digest",digest);state.put(operation,entry);save(context,state)
        // 账本只保存摘要和交接状态，不保存正文；系统可能拦截后台启动，不能据此声称已经保存。
        try {
            context.startActivity(request)
            val result=JSONObject().put("status","handoff").put("saved",false).put("target",target)
                .put("detail","已向笔记应用提交打开请求；请在目标应用核对并确认保存。如果没有出现页面，请先打开灵伴再操作。")
            entry.put("result",result);save(context,state);return result
        } catch(_:Exception) { return unknown() }
    }
}
