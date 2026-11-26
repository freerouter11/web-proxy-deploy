package com.freerouter.webproxy;

import com.freerouter.webproxy.Health;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class Health$$ExternalSyntheticLambda0 implements Runnable {
    public final /* synthetic */ Health.Listener f$0;

    public /* synthetic */ Health$$ExternalSyntheticLambda0(Health.Listener listener) {
        this.f$0 = listener;
    }

    @Override // java.lang.Runnable
    public final void run() {
        this.f$0.onAllDone(-1, -1);
    }
}
