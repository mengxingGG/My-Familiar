package app.familiar.platform

import android.content.Context
import org.json.JSONObject

/** Android 停靠偏好只保存在原生层，不改变桌面版宠物配置。 */
object PetDock {
    @Volatile var tucked = false
    var changed: (() -> Unit)? = null
    fun prefs(context: Context) = context.getSharedPreferences("pet-overlay-position", Context.MODE_PRIVATE)
    fun snapshot(context: Context) = prefs(context).let {
        JSONObject().put("snapToEdge", it.getBoolean("snapToEdge", false))
            .put("hideWhenIdle", it.getBoolean("hideWhenIdle", true))
            .put("delaySeconds", it.getInt("delaySeconds", 30)).put("tucked", tucked)
    }
    fun save(context: Context, p: JSONObject): Any {
        require(p.opt("snapToEdge") is Boolean && p.opt("hideWhenIdle") is Boolean && p.opt("delaySeconds") is Int)
        val seconds = p.getInt("delaySeconds"); require(seconds in 10..300)
        check(prefs(context).edit().putBoolean("snapToEdge", p.getBoolean("snapToEdge"))
            .putBoolean("hideWhenIdle", p.getBoolean("hideWhenIdle")).putInt("delaySeconds", seconds).commit())
        PetPresentation.main.post { changed?.invoke() }; return JSONObject.NULL
    }
    fun reset(context: Context) { prefs(context).edit().remove("x").remove("y").remove("edge").apply(); PetPresentation.reset?.invoke() }
}
