package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.content.ClipData
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

class FamiliarCameraProvider: FileProvider()

/** 只临时共享本次相机输出文件；不开放媒体库或其他应用私有目录。 */
object CameraCapture {
    data class Pending(val file: File, val uri: Uri, val intent: Intent)
    fun intent() = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
    fun prepare(context: Context): Pending {
        check(intent().resolveActivity(context.packageManager) != null)
        val directory = File(context.cacheDir, "camera-capture").apply { mkdirs() }
        directory.listFiles()?.filter { it.name.matches(Regex("[a-f0-9-]{36}\\.jpg")) && System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach {
            if (it.canonicalFile.parentFile == directory.canonicalFile) it.delete()
        }
        val file = File(directory, "${UUID.randomUUID()}.jpg").apply { createNewFile() }
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.familiar.camera", file)
            return Pending(file, uri, intent().apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                clipData = ClipData.newRawUri("照片", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            })
        } catch (error: Exception) { file.delete(); throw error }
    }
    fun cleanup(context: Context, pending: Pending?) {
        if (pending == null) return
        try { context.revokeUriPermission(pending.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        catch (_: Exception) { /* Activity 栈结束也会释放临时授权；清理不能锁死下次选择。 */ }
        try { if (pending.file.canonicalFile.parentFile == File(context.cacheDir, "camera-capture").canonicalFile) pending.file.delete() }
        catch (_: Exception) { /* 下次进入会清理过期的本应用相机缓存。 */ }
    }
}
