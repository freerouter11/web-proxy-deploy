package com.freerouter.webproxy;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;

/* loaded from: classes.dex */
public class SettingsActivity extends Activity {

    public interface BoolSetter {
        void set(boolean z);
    }

    @Override // android.app.Activity
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        setContentView(R.layout.activity_settings);
        LinearLayout linearLayout = (LinearLayout) findViewById(R.id.rows);
        linearLayout.addView(row(getString(R.string.layers_row), getString(R.string.layers_row_sub), new SettingsActivity$$ExternalSyntheticLambda1(this)));
        linearLayout.addView(rowSwitch(getString(R.string.keepalive_row), getString(R.string.keepalive_row_sub), Prefs.keepAlive(this), new SettingsActivity$$ExternalSyntheticLambda2(this)));
        linearLayout.addView(rowSwitch(getString(R.string.block_ads_row), getString(R.string.block_ads_row_sub), Prefs.blockAds(this), new SettingsActivity$$ExternalSyntheticLambda3(this)));
        linearLayout.addView(rowSwitch(getString(R.string.block_images_row), getString(R.string.block_images_row_sub), Prefs.blockImages(this), new SettingsActivity$$ExternalSyntheticLambda4(this)));
        linearLayout.addView(row(getString(R.string.clear_row), getString(R.string.clear_row_sub), new SettingsActivity$$ExternalSyntheticLambda5(this)));
        linearLayout.addView(row(getString(R.string.crash_row), getString(R.string.crash_row_sub), new SettingsActivity$$ExternalSyntheticLambda6(this)));
        linearLayout.addView(row(getString(R.string.reset_row), getString(R.string.reset_row_sub), new SettingsActivity$$ExternalSyntheticLambda7(this)));
        findViewById(R.id.btn_done).setOnClickListener(new SettingsActivity$$ExternalSyntheticLambda8(this));
    }

    /* renamed from: lambda$onCreate$0$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m29lambda$onCreate$0$comfreerouterwebproxySettingsActivity(View view) {
        startActivity(new Intent(this, (Class<?>) ServersActivity.class));
    }

    /* renamed from: lambda$onCreate$1$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m30lambda$onCreate$1$comfreerouterwebproxySettingsActivity(boolean z) {
        Prefs.setKeepAlive(this, z);
    }

    /* renamed from: lambda$onCreate$2$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m31lambda$onCreate$2$comfreerouterwebproxySettingsActivity(boolean z) {
        Prefs.setBlockAds(this, z);
    }

    /* renamed from: lambda$onCreate$3$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m32lambda$onCreate$3$comfreerouterwebproxySettingsActivity(boolean z) {
        Prefs.setBlockImages(this, z);
    }

    /* renamed from: lambda$onCreate$4$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m33lambda$onCreate$4$comfreerouterwebproxySettingsActivity(View view) {
        confirmClear();
    }

    /* renamed from: lambda$onCreate$5$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m34lambda$onCreate$5$comfreerouterwebproxySettingsActivity(View view) {
        showCrashes();
    }

    /* renamed from: lambda$onCreate$6$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m35lambda$onCreate$6$comfreerouterwebproxySettingsActivity(View view) {
        confirmReset();
    }

    /* renamed from: lambda$onCreate$7$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m36lambda$onCreate$7$comfreerouterwebproxySettingsActivity(View view) {
        finish();
    }

    private int dp(int i) {
        return (int) (i * getResources().getDisplayMetrics().density);
    }

    private View row(String str, String str2, View.OnClickListener onClickListener) {
        LinearLayout linearLayout = new LinearLayout(this);
        linearLayout.setOrientation(1);
        linearLayout.setPadding(dp(20), dp(14), dp(20), dp(14));
        linearLayout.setOnClickListener(onClickListener);
        if (Build.VERSION.SDK_INT >= 23) {
            linearLayout.setForeground(new ColorDrawable(337826798));
        }
        TextView textView = new TextView(this);
        textView.setText(str);
        textView.setTextSize(16.0f);
        textView.setTextColor(-920071);
        linearLayout.addView(textView);
        TextView textView2 = new TextView(this);
        textView2.setText(str2);
        textView2.setTextSize(12.5f);
        textView2.setTextColor(-7035976);
        textView2.setPadding(0, dp(3), 0, 0);
        linearLayout.addView(textView2);
        View view = new View(this);
        view.setBackgroundColor(-14800581);
        linearLayout.addView(view, new LinearLayout.LayoutParams(-1, 1));
        return linearLayout;
    }

    private View rowSwitch(String str, String str2, boolean z, BoolSetter boolSetter) {
        LinearLayout linearLayout = new LinearLayout(this);
        linearLayout.setOrientation(0);
        linearLayout.setGravity(16);
        linearLayout.setPadding(dp(20), dp(14), dp(20), dp(14));
        LinearLayout linearLayout2 = new LinearLayout(this);
        linearLayout2.setOrientation(1);
        TextView textView = new TextView(this);
        textView.setText(str);
        textView.setTextSize(16.0f);
        textView.setTextColor(-920071);
        linearLayout2.addView(textView);
        TextView textView2 = new TextView(this);
        textView2.setText(str2);
        textView2.setTextSize(12.5f);
        textView2.setTextColor(-7035976);
        textView2.setPadding(0, dp(3), 0, 0);
        linearLayout2.addView(textView2);
        linearLayout.addView(linearLayout2, new LinearLayout.LayoutParams(0, -2, 1.0f));
        Switch r7 = new Switch(this);
        r7.setChecked(z);
        r7.setOnCheckedChangeListener(new SettingsActivity$$ExternalSyntheticLambda0(boolSetter));
        linearLayout.addView(r7);
        View view = new View(this);
        view.setBackgroundColor(-14800581);
        linearLayout.addView(view, new LinearLayout.LayoutParams(-1, 1));
        return linearLayout;
    }

    private void confirmClear() {
        new AlertDialog.Builder(this).setMessage(getString(R.string.clear_confirm)).setPositiveButton(R.string.ok, new SettingsActivity$$ExternalSyntheticLambda11(this)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
    }

    /* renamed from: lambda$confirmClear$9$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m27lambda$confirmClear$9$comfreerouterwebproxySettingsActivity(DialogInterface dialogInterface, int i) {
        try {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            WebStorage.getInstance().deleteAllData();
            toast(getString(R.string.cleared));
        } catch (Exception unused) {
            toast(getString(R.string.cleared));
        }
    }

    private void confirmReset() {
        new AlertDialog.Builder(this).setMessage(getString(R.string.reset_confirm)).setPositiveButton(R.string.ok, new SettingsActivity$$ExternalSyntheticLambda12(this)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
    }

    /* renamed from: lambda$confirmReset$10$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m28lambda$confirmReset$10$comfreerouterwebproxySettingsActivity(DialogInterface dialogInterface, int i) {
        Prefs.setLayers(this, Prefs.builtinLayers(), 0);
        toast(getString(R.string.reset_done));
    }

    private void showCrashes() {
        File[] listFiles = new File(getFilesDir(), "crash").listFiles();
        if (listFiles == null || listFiles.length == 0) {
            toast(getString(R.string.no_crashes));
            return;
        }
        Arrays.sort(listFiles, new SettingsActivity$$ExternalSyntheticLambda9());
        StringBuilder sb = new StringBuilder();
        int min = Math.min(listFiles.length, 3);
        for (int i = 0; i < min; i++) {
            try {
                byte[] bArr = new byte[(int) Math.min(listFiles[i].length(), 8000L)];
                FileInputStream fileInputStream = new FileInputStream(listFiles[i]);
                int read = fileInputStream.read(bArr);
                fileInputStream.close();
                sb.append("===== ");
                sb.append(listFiles[i].getName());
                sb.append(" =====\n");
                sb.append(new String(bArr, 0, Math.max(read, 0)));
                sb.append("\n\n");
            } catch (Exception unused) {
            }
        }
        String sb2 = sb.toString();
        new AlertDialog.Builder(this).setTitle(R.string.crash_row).setMessage(sb2).setPositiveButton(R.string.ok, (DialogInterface.OnClickListener) null).setNeutralButton(R.string.menu_share, new SettingsActivity$$ExternalSyntheticLambda10(this, sb2)).show();
    }

    /* renamed from: lambda$showCrashes$12$com-freerouter-webproxy-SettingsActivity, reason: not valid java name */
    /* synthetic */ void m37lambda$showCrashes$12$comfreerouterwebproxySettingsActivity(String str, DialogInterface dialogInterface, int i) {
        Intent intent = new Intent("android.intent.action.SEND");
        intent.setType("text/plain");
        intent.putExtra("android.intent.extra.TEXT", str);
        try {
            startActivity(Intent.createChooser(intent, getString(R.string.menu_share)));
        } catch (Exception unused) {
        }
    }

    private void toast(String str) {
        try {
            Toast.makeText(this, str, 0).show();
        } catch (Throwable unused) {
        }
    }
}
