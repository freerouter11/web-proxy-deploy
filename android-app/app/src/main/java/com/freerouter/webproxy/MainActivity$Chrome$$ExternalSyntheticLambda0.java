package com.freerouter.webproxy;

import android.content.DialogInterface;
import android.webkit.WebChromeClient;
import com.freerouter.webproxy.MainActivity;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class MainActivity$Chrome$$ExternalSyntheticLambda0 implements DialogInterface.OnClickListener {
    public final /* synthetic */ MainActivity.Chrome f$0;
    public final /* synthetic */ boolean[] f$1;
    public final /* synthetic */ WebChromeClient.FileChooserParams f$2;

    public /* synthetic */ MainActivity$Chrome$$ExternalSyntheticLambda0(MainActivity.Chrome chrome, boolean[] zArr, WebChromeClient.FileChooserParams fileChooserParams) {
        this.f$0 = chrome;
        this.f$1 = zArr;
        this.f$2 = fileChooserParams;
    }

    @Override // android.content.DialogInterface.OnClickListener
    public final void onClick(DialogInterface dialogInterface, int i) {
        this.f$0.m11xcc94249d(this.f$1, this.f$2, dialogInterface, i);
    }
}
