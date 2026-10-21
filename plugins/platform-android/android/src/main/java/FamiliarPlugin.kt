package app.familiar.platform

import android.app.Activity
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.Executors

@TauriPlugin
class FamiliarPlugin(private val activity: Activity): Plugin(activity) {
    private val io = Executors.newCachedThreadPool()
    private var choosing = false
    private var exportingBackup: String? = null
    private var camera: CameraCapture.Pending? = null
    private val modelMethods = setOf("provider.models", "provider.inspect", "provider.test", "provider.test.cancel", "conversation.context", "context.archive")
    private val mcpMethods = setOf("mcp.list", "mcp.save", "mcp.github.save", "mcp.connect", "mcp.connect.cancel", "mcp.disconnect", "mcp.remove", "github.auth.status", "github.auth.configure", "github.auth.begin", "github.auth.open", "github.auth.cancel", "github.auth.forget", "github.auth.apply")
    private val careMethods = setOf("care.get", "care.save", "care.preview", "care.stop", "care.locate", "care.locate.cancel")
    private val feishuMethods = setOf("feishu.status", "feishu.save", "feishu.pair", "feishu.stop", "feishu.office.save", "feishu.office.check", "feishu.auth.begin", "feishu.auth.open", "feishu.auth.cancel", "feishu.auth.forget")
    private val libraryMethods = setOf("library.memory.list", "library.memory.read", "library.memory.write", "library.memory.search", "library.skills.list", "library.skills.read", "library.skills.source", "library.skills.install", "library.skills.toggle", "library.skills.remove")
    private val methods = setOf("backup.export", "backup.choose", "backup.inspect", "backup.apply", "backup.recovery", "backup.cancel", "policy.get", "policy.set", "policy.resetSession", "snapshot.get", "companion.save", "provider.save", "conversation.create", "conversation.select", "conversation.delete", "message.send", "reply.cancel", "capability.request", "task.respond", "runtime.set", "runtime.startup.save", "media.choose", "media.camera", "media.preview", "voice.local.catalog", "voice.save", "voice.start", "voice.finish", "voice.stop", "voice.read", "pet.settings.save", "pet.interact", "pet.docking.save")

    @Command
    fun invoke(invoke: Invoke) {
        // JSON 请求是开放结构；直接读取 org.json，避免 Jackson 把 JSObject 子类解析为空对象。
        val request = invoke.getArgs().optJSONObject("request") ?: JSONObject()
        val id = request.optString("id")
        fun failure(code: String) = JSObject().put("protocolVersion", 1).put("id", id).put("ok", false).put("error", JSONObject().put("code", code))
        if (request.optInt("protocolVersion") != 1 || id.length !in 1..100 || (request.optString("method") !in methods && request.optString("method") !in setOf("voice.wake.save", "voice.wake.start", "voice.system.input", "voice.live.save", "media.paste") && request.optString("method") !in libraryMethods && request.optString("method") !in modelMethods && request.optString("method") !in mcpMethods && request.optString("method") !in careMethods && request.optString("method") !in feishuMethods) || request.toString().toByteArray(Charsets.UTF_8).size > 1024 * 1024) {
            invoke.resolve(JSObject(failure("INVALID_INPUT").toString()))
            return
        }
        if (request.optString("method") in setOf("backup.export", "backup.choose")) {
            activity.runOnUiThread {
                if (choosing || !activity.hasWindowFocus() || activity.isFinishing) { invoke.resolve(failure("BUSY")); return@runOnUiThread }
                choosing = true
                if (request.optString("method") == "backup.choose") {
                    try { startActivityForResult(invoke, BackupDocuments.chooseIntent(), "backupChosen") }
                    catch (_:Exception) { choosing=false;invoke.resolve(failure("UNAVAILABLE")) }
                } else io.execute {
                    try {
                        val response=RuntimeClient.request(activity.applicationContext,request)
                        if (!response.optBoolean("ok")) { activity.runOnUiThread {choosing=false;invoke.resolve(JSObject(response.toString()))} }
                        else { val token=response.getJSONObject("result").getString("token");activity.runOnUiThread {
                            exportingBackup=token
                            try { startActivityForResult(invoke,BackupDocuments.createIntent(),"backupCreated") }
                            catch (_:Exception) { BackupDocuments.remove(activity,token);exportingBackup=null;choosing=false;invoke.resolve(failure("UNAVAILABLE")) }
                        } }
                    } catch (_:Exception) { activity.runOnUiThread {choosing=false;invoke.resolve(failure("UNAVAILABLE"))} }
                }
            }
            return
        }
        if (request.optString("method") == "media.paste") {
            if (!request.isNull("params")) { invoke.resolve(failure("INVALID_INPUT")); return }
            activity.runOnUiThread {
                if (choosing) { invoke.resolve(failure("BUSY")); return@runOnUiThread }
                try {
                    val uris = ClipboardImages.read(activity)
                    choosing = true
                    io.execute {
                        var tokens = emptyList<String>()
                        try {
                            tokens = MediaPicker.stage(activity.applicationContext, uris, "clipboard")
                            val imported = JSONObject().put("protocolVersion", 1).put("id", id).put("method", "media.import").put("params", JSONObject().put("tokens", JSONArray(tokens)))
                            invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, imported).toString()))
                        } catch (error: Exception) {
                            invoke.resolve(failure(if (error is IllegalArgumentException) "INVALID_INPUT" else "UNAVAILABLE"))
                        } finally {
                            MediaPicker.cleanup(activity.applicationContext, tokens)
                            activity.runOnUiThread { choosing = false }
                        }
                    }
                } catch (error: Exception) {
                    invoke.resolve(failure(if (error is IllegalArgumentException) "INVALID_INPUT" else if (error.message == "NOT_FOUND") "NOT_FOUND" else "UNAVAILABLE"))
                }
            }
            return
        }
        if (request.optString("method") == "voice.system.input") {
            activity.runOnUiThread {
                if (choosing) { invoke.resolve(failure("BUSY")); return@runOnUiThread }
                if (!activity.hasWindowFocus() || activity.isFinishing || !NativeLocation.interactive(activity) || !SystemSpeech.available(activity)) { invoke.resolve(failure("UNAVAILABLE")); return@runOnUiThread }
                val params = request.optJSONObject("params")
                val target = params?.opt("conversationId")
                if (params == null || !params.has("conversationId") || (target !== JSONObject.NULL && (target !is String || target.length > 100))) { invoke.resolve(failure("INVALID_INPUT")); return@runOnUiThread }
                choosing = true
                io.execute {
                    var error = "UNAVAILABLE"
                    try {
                        val snapshot = RuntimeClient.request(activity.applicationContext, JSONObject().put("protocolVersion", 1).put("id", id).put("method", "snapshot.get"))
                        check(snapshot.optBoolean("ok"))
                        val state = snapshot.getJSONObject("result"); val voice = state.getJSONObject("voice"); val phase = voice.getJSONObject("state")
                        if (phase.getBoolean("active") || phase.getString("phase") !in setOf("off", "sleeping", "error") || voice.optJSONObject("wake")?.optBoolean("armed") == true || !state.isNull("activeReply")) { error = "BUSY"; error("BUSY") }
                        val conversations = state.getJSONArray("conversations")
                        if (target is String && (0 until conversations.length()).none { conversations.getJSONObject(it).getString("id") == target }) { error = "NOT_FOUND"; error("NOT_FOUND") }
                        activity.runOnUiThread {
                            try {
                                check(activity.hasWindowFocus() && !activity.isFinishing && NativeLocation.interactive(activity))
                                startActivityForResult(invoke, SystemSpeech.intent(), "systemSpeechReturned")
                            } catch (_: Exception) { choosing = false; invoke.resolve(failure("UNAVAILABLE")) }
                        }
                    } catch (_: Exception) { activity.runOnUiThread { choosing = false; invoke.resolve(failure(error)) } }
                }
            }
            return
        }
        if (request.optString("method") in setOf("voice.wake.start", "voice.start")) {
            activity.runOnUiThread {
                if (choosing) { invoke.resolve(failure("BUSY")); return@runOnUiThread }
                if (!activity.hasWindowFocus() || activity.isFinishing || !NativeLocation.interactive(activity)) { invoke.resolve(failure("UNAVAILABLE")); return@runOnUiThread }
                val target = request.optJSONObject("params")?.opt("conversationId") ?: JSONObject.NULL
                val params = JSONObject().put("conversationId", target).put("foregroundAt", System.currentTimeMillis())
                if (request.optString("method") == "voice.start") params.put("mode", request.optJSONObject("params")?.opt("mode"))
                request.put("params", params)
                io.execute {
                    try { invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, request).toString())) }
                    catch (_: Exception) { invoke.resolve(failure("UNAVAILABLE")) }
                }
            }
            return
        }
        if (request.optString("method") in setOf("care.locate", "care.locate.cancel")) {
            val p = request.optJSONObject("params") ?: JSONObject()
            val operation = p.optString("operationId")
            if (!operation.matches(Regex("[a-zA-Z0-9:_-]{1,100}"))) { invoke.resolve(failure("INVALID_INPUT")); return }
            if (request.optString("method") == "care.locate.cancel") {
                NativeLocation.cancel(operation)
                invoke.resolve(JSObject().put("protocolVersion", 1).put("id", id).put("ok", true)); return
            }
            fun failed(error: Throwable) { val code = (error.cause ?: error).message?.takeIf { it in setOf("CANCELLED", "BUSY", "INVALID_INPUT", "CONFLICT") } ?: "UNAVAILABLE"; invoke.resolve(failure(code)) }
            io.execute {
                try {
                    val check = RuntimeClient.request(activity.applicationContext, JSONObject(request.toString()).put("method", "care.location.check"))
                    if (!check.optBoolean("ok")) { invoke.resolve(JSObject(check.toString())); return@execute }
                    activity.runOnUiThread {
                        try {
                            NativeLocation.request(activity, operation).whenComplete { value, error ->
                                if (error != null) failed(error)
                                else io.execute {
                                    try {
                                        check(!NativeLocation.isCancelled(operation)) { "CANCELLED" }
                                        val imported = JSONObject(request.toString()).put("method", "care.location.import")
                                            .put("params", JSONObject().put("revision", p.getString("revision")).put("value", value))
                                        invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, imported).toString()))
                                    } catch (e: Exception) { failed(e) }
                                }
                            }
                        } catch (e: Exception) { failed(e) }
                    }
                } catch (e: Exception) { failed(e) }
            }
            return
        }
        if (request.optString("method") in setOf("media.choose", "media.camera")) {
            activity.runOnUiThread {
                if (choosing) invoke.resolve(JSObject(failure("BUSY").toString()))
                else try {
                    choosing = true
                    val intent = if (request.optString("method") == "media.camera") CameraCapture.prepare(activity).also { camera = it }.intent else MediaPicker.intent()
                    startActivityForResult(invoke, intent, "mediaChosen")
                } catch (_: Exception) {
                    CameraCapture.cleanup(activity, camera); camera = null; choosing = false
                    invoke.resolve(JSObject(failure("UNAVAILABLE").toString()))
                }
            }
            return
        }
        if (request.optString("method") == "capability.request") {
            activity.runOnUiThread {
                try {
                    NativeCapabilities.request(activity, request.getJSONObject("params").getString("id"))
                    invoke.resolve(JSObject().put("protocolVersion", 1).put("id", id).put("ok", true))
                } catch (_: Exception) { invoke.resolve(JSObject(failure("UNAVAILABLE").toString())) }
            }
            return
        }
        if (request.optString("method") == "snapshot.get") {
            activity.runOnUiThread {
                request.put("params", JSONObject().put("controllerActive", activity.hasWindowFocus()))
                io.execute {
                    try { invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, request).toString())) }
                    catch (_: Exception) { invoke.resolve(JSObject(failure("UNAVAILABLE").toString())) }
                }
            }
            return
        }
        io.execute {
            try { invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, request).toString())) }
            catch (_: Exception) { invoke.resolve(JSObject(failure("UNAVAILABLE").toString())) }
        }
    }
    @ActivityCallback
    private fun backupCreated(invoke:Invoke,result:ActivityResult) {
        val request=invoke.getArgs().getJSONObject("request");val token=exportingBackup;exportingBackup=null
        io.execute {
            val response=JSObject().put("protocolVersion",1).put("id",request.getString("id"))
            try { val uri=result.data?.data;val saved=result.resultCode==Activity.RESULT_OK && uri!=null && token!=null
                if(saved) BackupDocuments.write(activity,token!!,uri!!)
                invoke.resolve(response.put("ok",true).put("result",JSONObject().put("saved",saved)))
            } catch (_:Exception) {invoke.resolve(response.put("ok",false).put("error",JSONObject().put("code","STORAGE")))}
            finally {if(token!=null) BackupDocuments.remove(activity,token);activity.runOnUiThread {choosing=false} }
        }
    }
    @ActivityCallback
    private fun backupChosen(invoke:Invoke,result:ActivityResult) {
        val request=invoke.getArgs().getJSONObject("request")
        io.execute {
            val response=JSObject().put("protocolVersion",1).put("id",request.getString("id"))
            try {val uri=result.data?.data;val token=if(result.resultCode==Activity.RESULT_OK && uri!=null) BackupDocuments.read(activity,uri) else null
                invoke.resolve(response.put("ok",true).put("result",JSONObject().put("token",token ?: JSONObject.NULL)))
            } catch (_:Exception) {invoke.resolve(response.put("ok",false).put("error",JSONObject().put("code","INVALID_BACKUP")))}
            finally {activity.runOnUiThread {choosing=false}}
        }
    }
    @ActivityCallback
    private fun systemSpeechReturned(invoke: Invoke, result: ActivityResult) {
        val request = invoke.getArgs().getJSONObject("request")
        val response = JSObject().put("protocolVersion", 1).put("id", request.getString("id"))
        try {
            val text = if (result.resultCode == Activity.RESULT_OK) SystemSpeech.text(result.data) else null
            invoke.resolve(response.put("ok", true).put("result", JSONObject().put("text", text ?: JSONObject.NULL)))
        } catch (_: Exception) { invoke.resolve(response.put("ok", false).put("error", JSONObject().put("code", "INVALID_INPUT"))) }
        finally { choosing = false }
    }
    @ActivityCallback
    private fun mediaChosen(invoke: Invoke, result: ActivityResult) {
        val request = invoke.getArgs().getJSONObject("request")
        val id = request.getString("id")
        fun response(ok: Boolean) = JSObject().put("protocolVersion", 1).put("id", id).put("ok", ok)
        if (result.resultCode != Activity.RESULT_OK) {
            CameraCapture.cleanup(activity, camera); camera = null
            choosing = false
            invoke.resolve(response(true).put("result", JSONArray())); return
        }
        val data = result.data
        val photo = camera; camera = null
        val clip = data?.clipData
        val uris = if (request.optString("method") == "media.camera") listOfNotNull(photo?.uri)
            else if (clip != null && clip.itemCount <= 8) (0 until clip.itemCount).map { clip.getItemAt(it).uri }
            else if (clip == null) listOfNotNull(data?.data) else emptyList()
        io.execute {
            var tokens = emptyList<String>()
            try {
                tokens = MediaPicker.stage(activity.applicationContext, uris)
                val imported = JSONObject().put("protocolVersion", 1).put("id", id).put("method", "media.import").put("params", JSONObject().put("tokens", JSONArray(tokens)))
                invoke.resolve(JSObject(RuntimeClient.request(activity.applicationContext, imported).toString()))
            } catch (error: Exception) {
                invoke.resolve(response(false).put("error", JSONObject().put("code", if (error is IllegalArgumentException) "INVALID_INPUT" else "UNAVAILABLE")))
            } finally {
                MediaPicker.cleanup(activity.applicationContext, tokens)
                CameraCapture.cleanup(activity.applicationContext, photo)
                activity.runOnUiThread { choosing = false }
            }
        }
    }
}
