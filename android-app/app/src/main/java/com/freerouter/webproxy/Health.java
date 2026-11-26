package com.freerouter.webproxy;

import android.os.Handler;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/* loaded from: classes.dex */
public final class Health {
    public static final int MAX_TRIES = 4;
    public static final long RETRY_MS = 9000;

    public interface Listener {
        void onAllDone(int i, int i2);

        void onFirstAwake(int i, int i2);

        void onLayer(int i, String str, int i2, int i3);
    }

    private Health() {
    }

    public static int probe(String str, int i) {
        HttpURLConnection httpURLConnection = null;
        try {
            httpURLConnection = (HttpURLConnection) new URL(str + "/health").openConnection();
            httpURLConnection.setConnectTimeout(i);
            httpURLConnection.setReadTimeout(i);
            httpURLConnection.setRequestMethod("GET");
            httpURLConnection.setUseCaches(false);
            if (httpURLConnection.getResponseCode() != 200) {
                return -1;
            }
            ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream();
            InputStream inputStream = httpURLConnection.getInputStream();
            byte[] bArr = new byte[64];
            while (true) {
                int read = inputStream.read(bArr);
                if (read <= 0 || byteArrayOutputStream.size() >= 256) {
                    break;
                }
                byteArrayOutputStream.write(bArr, 0, read);
            }
            inputStream.close();
            return "ok".equals(byteArrayOutputStream.toString("UTF-8").trim()) ? 0 : -1;
        } catch (Exception unused) {
            return -1;
        } finally {
            if (httpURLConnection != null) {
                httpURLConnection.disconnect();
            }
        }
    }

    public static int probeMs(String str, int i) {
        long currentTimeMillis = System.currentTimeMillis();
        if (probe(str, i) == 0) {
            return (int) (System.currentTimeMillis() - currentTimeMillis);
        }
        return -1;
    }

    /* renamed from: com.freerouter.webproxy.Health$1, reason: invalid class name */
    static class AnonymousClass1 extends Thread {
        final /* synthetic */ String val$base;

        AnonymousClass1(String str) {
            this.val$base = str;
        }

        @Override // java.lang.Thread, java.lang.Runnable
        public void run() {
            Health.probe(this.val$base, 4000);
        }
    }

    public static void silentPing(String str) {
        new AnonymousClass1(str).start();
    }

    public static void testAll(List<String> list, Handler handler, Listener listener) {
        if (list.isEmpty()) {
            handler.post(new Health$$ExternalSyntheticLambda0(listener));
            return;
        }
        int size = list.size();
        int[] iArr = {-1, Integer.MAX_VALUE};
        boolean[] zArr = {false};
        int[] iArr2 = {size};
        for (int i = 0; i < size; i++) {
            new AnonymousClass2(handler, listener, i, list.get(i), zArr, iArr, iArr2).start();
        }
    }

    /* renamed from: com.freerouter.webproxy.Health$2, reason: invalid class name */
    static class AnonymousClass2 extends Thread {
        final /* synthetic */ Listener val$L;
        final /* synthetic */ String val$base;
        final /* synthetic */ int[] val$best;
        final /* synthetic */ boolean[] val$firstSent;
        final /* synthetic */ int val$idx;
        final /* synthetic */ int[] val$remaining;
        final /* synthetic */ Handler val$ui;

        AnonymousClass2(Handler handler, Listener listener, int i, String str, boolean[] zArr, int[] iArr, int[] iArr2) {
            this.val$ui = handler;
            this.val$L = listener;
            this.val$idx = i;
            this.val$base = str;
            this.val$firstSent = zArr;
            this.val$best = iArr;
            this.val$remaining = iArr2;
        }

        @Override // java.lang.Thread, java.lang.Runnable
        public void run() {
            int i = -1;
            int i2 = -1;
            for (int i3 = 0; i3 < 4; i3++) {
                this.val$ui.post(new Health$2$$ExternalSyntheticLambda0(this.val$L, this.val$idx, i3));
                i2 = Health.probeMs(this.val$base, 9000);
                if (i2 >= 0) {
                    break;
                }
                if (i3 < 3) {
                    this.val$ui.post(new Health$2$$ExternalSyntheticLambda1(this.val$L, this.val$idx, i3 + 1));
                    try {
                        Thread.sleep(Health.RETRY_MS);
                    } catch (InterruptedException unused) {
                        return;
                    }
                }
            }
            if (i2 >= 0) {
                this.val$ui.post(new Health$2$$ExternalSyntheticLambda2(this.val$L, this.val$idx, i2));
                synchronized (this.val$firstSent) {
                    boolean[] zArr = this.val$firstSent;
                    if (!zArr[0]) {
                        zArr[0] = true;
                        this.val$ui.post(new Health$2$$ExternalSyntheticLambda3(this.val$L, this.val$idx, i2));
                    }
                }
                synchronized (this.val$best) {
                    int[] iArr = this.val$best;
                    if (i2 < iArr[1]) {
                        iArr[0] = this.val$idx;
                        iArr[1] = i2;
                    }
                }
            } else {
                this.val$ui.post(new Health$2$$ExternalSyntheticLambda4(this.val$L, this.val$idx));
            }
            synchronized (this.val$remaining) {
                int[] iArr2 = this.val$remaining;
                int i4 = iArr2[0] - 1;
                iArr2[0] = i4;
                if (i4 == 0) {
                    int[] iArr3 = this.val$best;
                    int i5 = iArr3[0];
                    int i6 = iArr3[1];
                    if (i6 != Integer.MAX_VALUE) {
                        i = i6;
                    }
                    this.val$ui.post(new Health$2$$ExternalSyntheticLambda5(this.val$L, i5, i));
                }
            }
        }
    }
}
