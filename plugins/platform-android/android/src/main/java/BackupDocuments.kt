package app.familiar.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** 系统选择器只传递用户选中的加密单文件，不请求存储目录权限。 */
object BackupDocuments {
    private const val limit=25*1024*1024
    private fun root(context:Context)=File(context.filesDir,"transfer").also {check(it.exists() || it.mkdirs()) { "UNAVAILABLE" }}
    fun file(context:Context,token:String):File {
        require(token.matches(Regex("[a-f0-9-]{36}"))) { "INVALID_INPUT" }
        val base=root(context).canonicalFile;val file=File(base,"$token.familiar")
        check(file.canonicalFile.parentFile==base && file.isFile && file.length() in 54..limit.toLong()) { "INVALID_INPUT" }
        return file
    }
    fun chooseIntent()=Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,false)
    fun createIntent()=Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,"Familiar-${java.time.LocalDate.now()}.familiar")
    fun read(context:Context,uri:Uri):String {
        require(uri.scheme=="content") { "INVALID_INPUT" }
        val token=UUID.randomUUID().toString();val destination=File(root(context),"$token.familiar")
        try {
            context.contentResolver.openInputStream(uri)?.use { input -> destination.outputStream().use { output ->
                val buffer=ByteArray(32768);var total=0
                while(true) {val count=input.read(buffer);if(count<0) break;total+=count;require(total<=limit) { "LIMIT" };output.write(buffer,0,count)}
                require(total>=54) { "INVALID_INPUT" }
            }} ?: throw IllegalStateException("UNAVAILABLE")
            file(context,token).inputStream().use { input -> val magic=ByteArray(8);check(input.read(magic)==8 && String(magic,Charsets.US_ASCII)=="FAMBAK1\n") { "INVALID_INPUT" } }
            return token
        } catch(e:Exception) { destination.delete();throw e }
    }
    fun write(context:Context,token:String,uri:Uri) {
        require(uri.scheme=="content") { "INVALID_INPUT" }
        val source=file(context,token)
        context.contentResolver.openOutputStream(uri,"wt")?.use { output -> source.inputStream().use { input -> input.copyTo(output) };output.flush() } ?: throw IllegalStateException("UNAVAILABLE")
    }
    fun remove(context:Context,token:String) { if(token.matches(Regex("[a-f0-9-]{36}"))) File(root(context),"$token.familiar").delete() }
    fun path(context:Context,p:JSONObject)=file(context,p.getString("token")).canonicalPath
}
