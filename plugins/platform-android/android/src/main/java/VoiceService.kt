package app.familiar.platform

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** 录音/播放服务独立于宠物，结束语音后释放麦克风与对应前台类型。 */
class VoiceService: Service() {
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("voice", "语音运行", NotificationManager.IMPORTANCE_LOW))
    }
    fun promote(microphone: Boolean, playback: Boolean, wake: Boolean = false) {
        val open = PendingIntent.getActivity(this, 20, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 21, Intent(this, VoiceService::class.java).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, "voice").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Familiar · 语音").setContentText(if (wake) "离线唤醒待机，麦克风正在使用" else if (microphone) "语音已开启，可随时停止" else "正在准备或播放语音")
            .setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, "停止语音", stop).build()).build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(7402, notification, (if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or (if (playback || !microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0))
        else startForeground(7402, notification)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { NativeAudio.userStop(this); stopSelf(); return START_NOT_STICKY }
        try { promote(intent?.getBooleanExtra("microphone", false) == true, intent?.getBooleanExtra("microphone", false) != true); NativeAudio.attach(this) }
        catch (_: Exception) { NativeAudio.failed(this); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onDestroy() { NativeAudio.detached(this); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
