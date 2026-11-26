package com.freerouter.webproxy;

import android.widget.CompoundButton;
import com.freerouter.webproxy.SettingsActivity;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class SettingsActivity$$ExternalSyntheticLambda0 implements CompoundButton.OnCheckedChangeListener {
    public final /* synthetic */ SettingsActivity.BoolSetter f$0;

    public /* synthetic */ SettingsActivity$$ExternalSyntheticLambda0(SettingsActivity.BoolSetter boolSetter) {
        this.f$0 = boolSetter;
    }

    @Override // android.widget.CompoundButton.OnCheckedChangeListener
    public final void onCheckedChanged(CompoundButton compoundButton, boolean z) {
        this.f$0.set(z);
    }
}
