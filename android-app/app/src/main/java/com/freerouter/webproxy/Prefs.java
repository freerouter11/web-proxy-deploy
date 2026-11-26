package com.freerouter.webproxy;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/* loaded from: classes.dex */
public final class Prefs {
    private static final String FILE = "webproxy";
    private static final String K_ACTIVE = "active";
    private static final String K_BLOCKADS = "blockads";
    private static final String K_BLOCKIMG = "blockimg";
    private static final String K_KEEPALIVE = "keepalive";
    private static final String K_LASTMS = "lastms";
    private static final String K_LAYERS = "layers";
    private static final String K_SEEDV = "seedv";

    private Prefs() {
    }

    private static SharedPreferences sp(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, 0);
    }

    public static List<String[]> builtinLayers() {
        ArrayList arrayList = new ArrayList();
        arrayList.add(new String[]{"ورکر اصلی (کلادفلر)", "https://web-proxy.aiaikoio323.workers.dev"});
        arrayList.add(new String[]{"کلادفلر ۲", "https://web-proxy-b.aiaikoio323.workers.dev"});
        arrayList.add(new String[]{"کلادفلر ۳", "https://web-proxy-c.aiaikoio323.workers.dev"});
        arrayList.add(new String[]{"کلادفلر ۴", "https://web-proxy-d.aiaikoio323.workers.dev"});
        arrayList.add(new String[]{"کلادفلر پی (Pages)", "https://web-proxy-p.pages.dev"});
        return arrayList;
    }

    public static void seedIfNeeded(Context context) {
        SharedPreferences sp = sp(context);
        boolean z = false;
        if (sp.getInt(K_SEEDV, 0) >= 1) {
            return;
        }
        List<String[]> layers = layers(context);
        for (String[] strArr : builtinLayers()) {
            Iterator<String[]> it = layers.iterator();
            while (true) {
                if (it.hasNext()) {
                    if (it.next()[1].equals(strArr[1])) {
                        break;
                    }
                } else {
                    layers.add(strArr);
                    z = true;
                    break;
                }
            }
        }
        if (z) {
            setLayers(context, layers, active(context));
        }
        sp.edit().putInt(K_SEEDV, 1).apply();
    }

    public static boolean addLayer(Context context, String str, String str2) {
        List<String[]> layers = layers(context);
        Iterator<String[]> it = layers.iterator();
        while (it.hasNext()) {
            if (it.next()[1].equals(str2)) {
                return false;
            }
        }
        layers.add(new String[]{str, str2});
        setLayers(context, layers, active(context));
        return true;
    }

    public static boolean blockAds(Context context) {
        return sp(context).getBoolean(K_BLOCKADS, true);
    }

    public static void setBlockAds(Context context, boolean z) {
        sp(context).edit().putBoolean(K_BLOCKADS, z).apply();
    }

    public static boolean blockImages(Context context) {
        return sp(context).getBoolean(K_BLOCKIMG, false);
    }

    public static void setBlockImages(Context context, boolean z) {
        sp(context).edit().putBoolean(K_BLOCKIMG, z).apply();
    }

    public static List<String[]> layers(Context context) {
        ArrayList arrayList = new ArrayList();
        try {
            JSONArray jSONArray = new JSONArray(sp(context).getString(K_LAYERS, "[]"));
            for (int i = 0; i < jSONArray.length(); i++) {
                JSONObject jSONObject = jSONArray.getJSONObject(i);
                arrayList.add(new String[]{jSONObject.optString("name", ""), jSONObject.optString("url", "")});
            }
        } catch (Exception unused) {
        }
        return arrayList;
    }

    public static void setLayers(Context context, List<String[]> list, int i) {
        JSONArray jSONArray = new JSONArray();
        try {
            for (String[] strArr : list) {
                JSONObject jSONObject = new JSONObject();
                jSONObject.put("name", strArr[0]);
                jSONObject.put("url", strArr[1]);
                jSONArray.put(jSONObject);
            }
        } catch (Exception unused) {
        }
        sp(context).edit().putString(K_LAYERS, jSONArray.toString()).putInt(K_ACTIVE, Math.max(0, Math.min(i, list.size() - 1))).apply();
    }

    public static int active(Context context) {
        List<String[]> layers = layers(context);
        int i = sp(context).getInt(K_ACTIVE, 0);
        if (i < 0 || i >= layers.size()) {
            return 0;
        }
        return i;
    }

    public static void setActive(Context context, int i) {
        sp(context).edit().putInt(K_ACTIVE, i).apply();
    }

    public static String activeUrl(Context context) {
        List<String[]> layers = layers(context);
        int active = active(context);
        return active < layers.size() ? layers.get(active)[1] : "";
    }

    public static String activeName(Context context) {
        List<String[]> layers = layers(context);
        int active = active(context);
        return active < layers.size() ? layers.get(active)[0] : "";
    }

    public static boolean keepAlive(Context context) {
        return sp(context).getBoolean(K_KEEPALIVE, true);
    }

    public static void setKeepAlive(Context context, boolean z) {
        sp(context).edit().putBoolean(K_KEEPALIVE, z).apply();
    }

    public static void setLastMs(Context context, String str, int i) {
        try {
            JSONObject jSONObject = new JSONObject(sp(context).getString(K_LASTMS, "{}"));
            jSONObject.put(str, i);
            sp(context).edit().putString(K_LASTMS, jSONObject.toString()).apply();
        } catch (Exception unused) {
        }
    }

    public static int lastMs(Context context, String str) {
        try {
            return new JSONObject(sp(context).getString(K_LASTMS, "{}")).optInt(str, -1);
        } catch (Exception unused) {
            return -1;
        }
    }
}
