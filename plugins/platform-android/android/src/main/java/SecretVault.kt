package app.familiar.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 凭据只在 Keystore/核心进程边界使用，永不回填普通 UI。 */
object SecretVault {
    private const val alias = "familiar.model.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(context: Context): JSONObject {
        val file = AtomicFile(File(context.noBackupFilesDir, "credentials.v1"))
        if (!file.baseFile.exists()) return JSONObject()
        val value = file.readFully()
        require(value.size in 29..262144)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(value.copyOfRange(12, value.size)), Charsets.UTF_8))
    }
    @Synchronized fun write(context: Context, name: String, value: String?) {
        require(name.matches(Regex("[a-zA-Z0-9._:-]{1,200}")))
        require(value == null || value.length <= if (name == "feishu-user") 65536 else 16384)
        val current = read(context)
        if (value == null) current.remove(name) else current.put(name, value)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.iv + cipher.doFinal(current.toString().toByteArray(Charsets.UTF_8))
        require(bytes.size <= 262144)
        val file = AtomicFile(File(context.noBackupFilesDir, "credentials.v1"))
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (e: Exception) { file.failWrite(stream); throw e }
    }
}
