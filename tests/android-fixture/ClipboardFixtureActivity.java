package app.familiar.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Parcel;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;

/** 备份仅存测试包私有目录，恢复后删除；不显示或上传原剪贴板内容。 */
public class ClipboardFixtureActivity extends Activity implements View.OnClickListener {
    private static ClipData original;
    private static boolean backedUp;
    private TextView status;
    private File backupFile() { return new File(getFilesDir(),"clipboard-backup"); }
    private void saveBackup(ClipData clip) throws Exception {
        try(FileOutputStream file=new FileOutputStream(backupFile());DataOutputStream out=new DataOutputStream(file)) {
            out.writeBoolean(clip!=null);
            if(clip!=null) { Parcel parcel=Parcel.obtain();try {clip.writeToParcel(parcel,0);byte[] data=parcel.marshall();out.writeInt(data.length);out.write(data);} finally{parcel.recycle();} }
            out.flush();file.getFD().sync();
        }
        original=clip;backedUp=true;
    }
    private void loadBackup() throws Exception {
        if(backedUp||!backupFile().isFile())return;
        try(DataInputStream in=new DataInputStream(new FileInputStream(backupFile()))) {
            if(in.readBoolean()) {int size=in.readInt();if(size<0||size>1024*1024)throw new IllegalStateException();byte[] data=new byte[size];in.readFully(data);Parcel parcel=Parcel.obtain();try{parcel.unmarshall(data,0,size);parcel.setDataPosition(0);original=ClipData.CREATOR.createFromParcel(parcel);}finally{parcel.recycle();}}
            else original=null;
            backedUp=true;
        }
    }
    protected void onNewIntent(Intent intent) { super.onNewIntent(intent);setIntent(intent);status.setText("剪贴板隔离测试 · "+intent.getStringExtra("mode")); }
    public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(48,180,48,24);
        status=new TextView(this);status.setText("剪贴板隔离测试 · "+getIntent().getStringExtra("mode"));box.addView(status);
        for(String label:new String[]{"复制测试内容","恢复原剪贴板","清除遗留测试文字"}) { Button b=new Button(this);b.setText(label);b.setOnClickListener(this);box.addView(b); }
        setContentView(box);
    }
    public void onClick(View view) {
      try {
        ClipboardManager clipboard=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
        loadBackup();
        if (((Button)view).getText().equals("清除遗留测试文字")) {
            ClipData clip=clipboard.getPrimaryClip();
            if(clip!=null&&clip.getItemCount()==1&&"剪贴板文字不应作为图片读取".contentEquals(clip.getItemAt(0).getText()==null?"":clip.getItemAt(0).getText())) { clipboard.clearPrimaryClip();status.setText("已清除遗留测试文字"); }
            else status.setText("未发现遗留测试文字，未改动剪贴板");
            return;
        }
        if (((Button)view).getText().equals("恢复原剪贴板")) {
            if (!backedUp) { status.setText("未备份，不能恢复");return; }
            if(original==null)clipboard.clearPrimaryClip();else clipboard.setPrimaryClip(original);
            if(!backupFile().delete())throw new IllegalStateException("backup cleanup failed");
            original=null;backedUp=false;status.setText("已恢复原剪贴板");return;
        }
        if(!backedUp) saveBackup(clipboard.getPrimaryClip());
        String mode=getIntent().getStringExtra("mode");
        if("empty".equals(mode)) clipboard.clearPrimaryClip();
        else {
            ClipData clip;
            if("plain".equals(mode))clip=ClipData.newPlainText("fixture","剪贴板文字不应作为图片读取");
            else if("intent".equals(mode))clip=ClipData.newIntent("fixture",new Intent(Intent.ACTION_VIEW,Uri.parse("https://example.invalid")));
            else if("file".equals(mode))clip=ClipData.newRawUri("fixture",Uri.parse("file:///private/never-read.png"));
            else if("https".equals(mode))clip=ClipData.newRawUri("fixture",Uri.parse("https://example.invalid/never-load.png"));
            else {
                Uri uri=Uri.parse("content://app.familiar.fixture.clipboard/"+("many".equals(mode)?"image":mode));
                clip=ClipData.newUri(getContentResolver(),"fixture",uri);
                if("many".equals(mode))for(int i=1;i<9;i++)clip.addItem(new ClipData.Item(uri));
            }
            clipboard.setPrimaryClip(clip);
        }
        status.setText("已复制测试内容 · SHA256="+ClipboardFixtureProvider.digest(new File(getCacheDir(),"clipboard.png"))+" · reads="+ClipboardFixtureProvider.reads);
      } catch(Exception error) { status.setText("测试未执行："+error.getClass().getSimpleName()); }
    }
}
