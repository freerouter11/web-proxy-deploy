package com.freerouter.webproxy;

import android.content.DialogInterface;
import android.widget.EditText;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class ServersActivity$$ExternalSyntheticLambda8 implements DialogInterface.OnClickListener {
    public final /* synthetic */ ServersActivity f$0;
    public final /* synthetic */ EditText f$1;
    public final /* synthetic */ EditText f$2;

    public /* synthetic */ ServersActivity$$ExternalSyntheticLambda8(ServersActivity serversActivity, EditText editText, EditText editText2) {
        this.f$0 = serversActivity;
        this.f$1 = editText;
        this.f$2 = editText2;
    }

    @Override // android.content.DialogInterface.OnClickListener
    public final void onClick(DialogInterface dialogInterface, int i) {
        this.f$0.m15lambda$addDialog$9$comfreerouterwebproxyServersActivity(this.f$1, this.f$2, dialogInterface, i);
    }
}
