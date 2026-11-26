package com.freerouter.webproxy;

import com.freerouter.webproxy.Health;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class Health$2$$ExternalSyntheticLambda4 implements Runnable {
    public final /* synthetic */ Health.Listener f$0;
    public final /* synthetic */ int f$1;

    public /* synthetic */ Health$2$$ExternalSyntheticLambda4(Health.Listener listener, int i) {
        this.f$0 = listener;
        this.f$1 = i;
    }

    @Override // java.lang.Runnable
    public final void run() {
        this.f$0.onLayer(this.f$1, "dead", -1, 0);
    }
}
