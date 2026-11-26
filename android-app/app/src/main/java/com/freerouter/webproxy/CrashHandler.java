package com.freerouter.webproxy;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;
import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.Thread;
import java.util.Arrays;
import java.util.Date;

/* loaded from: classes.dex */
public class CrashHandler implements Thread.UncaughtExceptionHandler {
    private final Context ctx;
    private final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();

    private CrashHandler(Context context) {
        this.ctx = context.getApplicationContext();
    }

    public static void install(Context context) {
        Thread.setDefaultUncaughtExceptionHandler(new CrashHandler(context));
    }

    @Override // java.lang.Thread.UncaughtExceptionHandler
    public void uncaughtException(Thread thread, Throwable th) {
        try {
            File file = new File(this.ctx.getFilesDir(), "crash");
            if (!file.exists()) {
                file.mkdirs();
            }
            File[] listFiles = file.listFiles();
            if (listFiles != null && listFiles.length >= 5) {
                Arrays.sort(listFiles);
                listFiles[0].delete();
            }
            PrintWriter printWriter = new PrintWriter(new FileWriter(new File(file, "crash-" + System.currentTimeMillis() + ".txt")));
            StringBuilder sb = new StringBuilder("time=");
            sb.append(new Date());
            printWriter.println(sb.toString());
            printWriter.println("thread=" + thread.getName());
            StringWriter stringWriter = new StringWriter();
            th.printStackTrace(new PrintWriter(stringWriter));
            printWriter.println(stringWriter);
            printWriter.close();
        } catch (Throwable unused) {
        }
        try {
            new Handler(Looper.getMainLooper()).post(new CrashHandler$$ExternalSyntheticLambda0(this));
        } catch (Throwable unused2) {
        }
        try {
            Intent intent = new Intent(this.ctx, (Class<?>) MainActivity.class);
            intent.addFlags(268468224);
            PendingIntent activity = PendingIntent.getActivity(this.ctx, 0, intent, 1140850688);
            AlarmManager alarmManager = (AlarmManager) this.ctx.getSystemService("alarm");
            if (alarmManager != null) {
                alarmManager.set(1, System.currentTimeMillis() + 900, activity);
            }
        } catch (Throwable unused3) {
        }
        Thread.UncaughtExceptionHandler uncaughtExceptionHandler = this.prev;
        if (uncaughtExceptionHandler != null) {
            uncaughtExceptionHandler.uncaughtException(thread, th);
        }
    }

    /* renamed from: lambda$uncaughtException$0$com-freerouter-webproxy-CrashHandler, reason: not valid java name */
    /* synthetic */ void m0lambda$uncaughtException$0$comfreerouterwebproxyCrashHandler() {
        try {
            Toast.makeText(this.ctx, R.string.crash_msg, 0).show();
        } catch (Throwable unused) {
        }
    }
}
