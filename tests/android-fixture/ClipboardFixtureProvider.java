package app.familiar.fixture;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.security.MessageDigest;

/** 仅测试包：跨 UID 内容授权、原图与坏内容，不进入主 APK。 */
public class ClipboardFixtureProvider extends ContentProvider {
    private File image;
    public static int reads = 0;
    public boolean onCreate() {
        try {
            image = new File(getContext().getCacheDir(), "clipboard.png");
            Bitmap bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888);
            for (int y=0;y<128;y++) for (int x=0;x<128;x++) bitmap.setPixel(x,y,0xff000000 | (x*2<<16) | (y*2<<8) | ((x+y)%256));
            try (FileOutputStream out = new FileOutputStream(image)) { bitmap.compress(Bitmap.CompressFormat.PNG,100,out); }
            bitmap.recycle();
            try (RandomAccessFile out = new RandomAccessFile(new File(getContext().getCacheDir(),"large.png"),"rw")) { out.setLength(13*1024*1024); }
            Files.write(new File(getContext().getCacheDir(),"corrupt.png").toPath(), "not an image".getBytes("UTF-8"));
            return true;
        } catch(Exception e) { throw new IllegalStateException(e); }
    }
    private File file(Uri uri) { String name=uri.getLastPathSegment();return "large".equals(name)?new File(getContext().getCacheDir(),"large.png"):"corrupt".equals(name)?new File(getContext().getCacheDir(),"corrupt.png"):image; }
    public String getType(Uri uri) { return "text".equals(uri.getLastPathSegment())?"text/plain":"image/png"; }
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort) {
        MatrixCursor cursor=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});
        cursor.addRow(new Object[]{"剪贴板图片.png",file(uri).length()}); return cursor;
    }
    public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {
        reads++; if (!"r".equals(mode)||"missing".equals(uri.getLastPathSegment())) throw new FileNotFoundException();
        if ("slow".equals(uri.getLastPathSegment())) try { Thread.sleep(2200); } catch(InterruptedException e) { Thread.currentThread().interrupt();throw new FileNotFoundException(); }
        return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public static String digest(File image) {
        try { byte[] value=MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(image.toPath()));StringBuilder out=new StringBuilder();for(byte b:value)out.append(String.format("%02x",b));return out.toString(); }
        catch(Exception e) { throw new IllegalStateException(e); }
    }
    public Uri insert(Uri uri,ContentValues values) { throw new UnsupportedOperationException(); }
    public int update(Uri uri,ContentValues values,String where,String[] args) { throw new UnsupportedOperationException(); }
    public int delete(Uri uri,String where,String[] args) { throw new UnsupportedOperationException(); }
}
