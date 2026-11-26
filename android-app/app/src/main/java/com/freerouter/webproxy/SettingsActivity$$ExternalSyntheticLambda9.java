package com.freerouter.webproxy;

import java.io.File;
import java.util.Comparator;

/* compiled from: D8$$SyntheticClass */
/* loaded from: classes.dex */
public final /* synthetic */ class SettingsActivity$$ExternalSyntheticLambda9 implements Comparator {
    @Override // java.util.Comparator
    public final int compare(Object obj, Object obj2) {
        int compare;
        compare = Long.compare(((File) obj2).lastModified(), ((File) obj).lastModified());
        return compare;
    }
}
