package com.freerouter.webproxy;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileNotFoundException;

/* loaded from: classes.dex */
public class CamProvider extends ContentProvider {
    public static final String AUTH = "com.freerouter.webproxy.cam";
    private static final String[] COLS = {"_display_name", "_size"};

    @Override // android.content.ContentProvider
    public int delete(Uri uri, String str, String[] strArr) {
        return 0;
    }

    @Override // android.content.ContentProvider
    public Uri insert(Uri uri, ContentValues contentValues) {
        return null;
    }

    @Override // android.content.ContentProvider
    public boolean onCreate() {
        return true;
    }

    @Override // android.content.ContentProvider
    public int update(Uri uri, ContentValues contentValues, String str, String[] strArr) {
        return 0;
    }

    private File fileOf(Uri uri) {
        String lastPathSegment = uri.getLastPathSegment();
        if (lastPathSegment == null || lastPathSegment.contains("/") || lastPathSegment.contains("\\") || lastPathSegment.contains("..")) {
            return null;
        }
        return new File(new File(getContext().getCacheDir(), "captures"), lastPathSegment);
    }

    @Override // android.content.ContentProvider
    public ParcelFileDescriptor openFile(Uri uri, String str) throws FileNotFoundException {
        int i;
        File fileOf = fileOf(uri);
        if (fileOf == null) {
            throw new FileNotFoundException("نشانی نامعتبر");
        }
        str.hashCode();
        switch (str) {
            case "w":
            case "wt":
                i = 738197504;
                break;
            case "rw":
            case "rwt":
                i = 1006632960;
                break;
            default:
                i = 268435456;
                break;
        }
        return ParcelFileDescriptor.open(fileOf, i);
    }

    @Override // android.content.ContentProvider
    public Cursor query(Uri uri, String[] strArr, String str, String[] strArr2, String str2) {
        File fileOf = fileOf(uri);
        if (strArr == null || strArr.length == 0) {
            strArr = COLS;
        }
        MatrixCursor matrixCursor = new MatrixCursor(strArr, 1);
        if (fileOf != null) {
            Object[] objArr = new Object[strArr.length];
            for (int i = 0; i < strArr.length; i++) {
                if ("_display_name".equals(strArr[i])) {
                    objArr[i] = fileOf.getName();
                } else if ("_size".equals(strArr[i])) {
                    objArr[i] = Long.valueOf(fileOf.length());
                } else {
                    objArr[i] = null;
                }
            }
            matrixCursor.addRow(objArr);
        }
        return matrixCursor;
    }

    @Override // android.content.ContentProvider
    public String getType(Uri uri) {
        return "image/jpeg";
    }
}
