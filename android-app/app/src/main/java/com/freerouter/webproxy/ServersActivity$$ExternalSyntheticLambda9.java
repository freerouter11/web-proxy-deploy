package com.freerouter.webproxy;

import android.content.DialogInterface;
import android.widget.EditText;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class ServersActivity$$ExternalSyntheticLambda9 implements DialogInterface.OnClickListener {
    public final /* synthetic */ ServersActivity f$0;
    public final /* synthetic */ EditText f$1;
    public final /* synthetic */ int f$2;

    public /* synthetic */ ServersActivity$$ExternalSyntheticLambda9(ServersActivity serversActivity, EditText editText, int i) {
        this.f$0 = serversActivity;
        this.f$1 = editText;
        this.f$2 = i;
    }

    @Override // android.content.DialogInterface.OnClickListener
    public final void onClick(DialogInterface dialogInterface, int i) {
        this.f$0.m24lambda$renameDialog$10$comfreerouterwebproxyServersActivity(this.f$1, this.f$2, dialogInterface, i);
    }
}
