package com.freerouter.webproxy;

import com.freerouter.webproxy.Health;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class Health$2$$ExternalSyntheticLambda1 implements Runnable {
    public final /* synthetic */ Health.Listener f$0;
    public final /* synthetic */ int f$1;
    public final /* synthetic */ int f$2;

    public /* synthetic */ Health$2$$ExternalSyntheticLambda1(Health.Listener listener, int i, int i2) {
        this.f$0 = listener;
        this.f$1 = i;
        this.f$2 = i2;
    }

    @Override // java.lang.Runnable
    public final void run() {
        this.f$0.onLayer(this.f$1, "wake", -1, this.f$2);
    }
}
