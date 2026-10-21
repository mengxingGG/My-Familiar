package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.graphics.*
import android.media.ExifInterface
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** SAF 只读用户选择的 URI；原件转入私有暂存区，不经 WebView 或大块 IPC 传输。 */
object MediaPicker {
    private const val MAX_BYTES = 12 * 1024 * 1024
    private val documentTypes = setOf("application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    fun intent() = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/png", "image/jpeg", "image/webp", "image/gif", "text/*", "application/json") + documentTypes)
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    fun stage(context: Context, uris: List<Uri>, source: String = "file"): List<String> {
        require(source in setOf("file", "clipboard"))
        require(uris.size in 1..8 && uris.all { it.scheme == "content" })
        val inbox = File(context.filesDir, "media-inbox").apply { mkdirs() }
        // 未完成的旧导入只清理本应用生成的 UUID 目录。
        inbox.listFiles()?.filter { it.name.matches(Regex("[a-f0-9-]{36}")) && System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach {
            if (it.canonicalFile.parentFile == inbox.canonicalFile) it.deleteRecursively()
        }
        val tokens = mutableListOf<String>()
        try {
            for (uri in uris.distinct()) {
                val resolver = context.contentResolver
                var name = "附件"
                var reportedSize = -1L
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) reportedSize = cursor.getLong(sizeIndex)
                    }
                }
                val mime = resolver.getType(uri)?.lowercase() ?: ""
                val image = mime in setOf("image/png", "image/jpeg", "image/webp", "image/gif")
                val document = mime in documentTypes
                require(image || document || mime.startsWith("text/") || mime == "application/json")
                require(source != "clipboard" || image)
                val limit = if (image || document) MAX_BYTES else 400000
                require(reportedSize <= limit)
                val token = UUID.randomUUID().toString(); tokens.add(token)
                val directory = File(inbox, token).apply { mkdirs() }
                val file = File(directory, "data")
                val descriptor = resolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("UNAVAILABLE")
                val main = Handler(Looper.getMainLooper())
                val timeout = Runnable { try { descriptor.close() } catch (_: Exception) {} }
                main.postDelayed(timeout, 60000)
                try {
                    ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                        file.outputStream().use { output ->
                            val buffer = ByteArray(32768); var total = 0
                            while (true) {
                                val count = input.read(buffer); if (count < 0) break
                                total += count; require(total <= limit)
                                output.write(buffer, 0, count)
                            }
                            require(total > 0)
                        }
                    }
                } finally { main.removeCallbacks(timeout); try { descriptor.close() } catch (_: Exception) {} }
                if (image) {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.path, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 64000000)
                    try { thumbnail(file, File(directory, "preview.jpg")) }
                    catch (error: IllegalArgumentException) { throw error }
                    catch (_: Exception) { /* 缩略图写入失败不丢弃已校验原件。 */ }
                }
                File(directory, "meta.json").writeText(JSONObject().put("name", name.filter { it >= ' ' }.take(160)).put("mimeType", if (image || document) mime else "text/plain").put("source", source).toString(), Charsets.UTF_8)
            }
            return tokens
        } catch (error: Exception) { cleanup(context, tokens); throw error }
    }
    fun cleanup(context: Context, tokens: List<String>) {
        val inbox = File(context.filesDir, "media-inbox").canonicalFile
        for (token in tokens) if (token.matches(Regex("[a-f0-9-]{36}"))) {
            val directory = File(inbox, token)
            if (directory.canonicalFile.parentFile == inbox) directory.deleteRecursively()
        }
    }
    /** 系统截图进入同一个媒体导入通道；大块像素不通过 JSON/JS 桥。 */
    fun stageScreen(context: Context, bitmap: Bitmap): String {
        require(bitmap.width.toLong() * bitmap.height <= 64000000)
        val token = UUID.randomUUID().toString()
        val directory = File(context.filesDir, "media-inbox/$token").apply { mkdirs() }
        try {
            val file = File(directory, "data")
            file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) }
            require(file.length() in 1..MAX_BYTES.toLong())
            thumbnail(file, File(directory, "preview.jpg"))
            File(directory, "meta.json").writeText(JSONObject().put("name", "屏幕-${System.currentTimeMillis()}.jpg").put("mimeType", "image/jpeg").put("source", "screen").toString(), Charsets.UTF_8)
            return token
        } catch (error: Exception) { cleanup(context, listOf(token)); throw error }
    }
    private fun thumbnail(source: File, target: File) {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.path, options)
        require(options.outWidth > 0 && options.outHeight > 0 && options.outWidth.toLong() * options.outHeight <= 64000000)
        var sample = 1
        while (maxOf(options.outWidth, options.outHeight) / sample > 800) sample *= 2
        options.inJustDecodeBounds = false; options.inSampleSize = sample
        val decoded = BitmapFactory.decodeFile(source.path, options) ?: throw IllegalArgumentException("INVALID_INPUT")
        var oriented = decoded
        try {
            val orientation = try { ExifInterface(source.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) } catch (_: Exception) { 1 }
            val matrix = Matrix().apply {
                when (orientation) {
                    2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
                    5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
                    7 -> { setRotate(270f); postScale(-1f, 1f) }; 8 -> setRotate(270f)
                }
            }
            if (orientation in 2..8) oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            val white = Bitmap.createBitmap(oriented.width, oriented.height, Bitmap.Config.ARGB_8888)
            try {
                Canvas(white).apply { drawColor(Color.WHITE); drawBitmap(oriented, 0f, 0f, null) }
                val bytes = ByteArrayOutputStream().use { output -> white.compress(Bitmap.CompressFormat.JPEG, 85, output); output.toByteArray() }
                if (bytes.size <= 750000) target.writeBytes(bytes)
            } finally { white.recycle() }
        } finally { if (oriented !== decoded) oriented.recycle(); decoded.recycle() }
    }
}
