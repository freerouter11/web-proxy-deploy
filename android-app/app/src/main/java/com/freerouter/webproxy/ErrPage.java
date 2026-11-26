package com.freerouter.webproxy;

import android.net.Uri;

/* loaded from: classes.dex */
public final class ErrPage {

    public static class Btn {
        public final String cmd;
        public final String label;
        public final String style;

        public Btn(String str, String str2, String str3) {
            this.label = str;
            this.cmd = str2;
            this.style = str3;
        }
    }

    private ErrPage() {
    }

    public static String esc(String str) {
        if (str == null) {
            return "";
        }
        return str.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    public static String build(String str, String str2, String str3, String str4, Btn[] btnArr) {
        String str5;
        StringBuilder sb = new StringBuilder("<!doctype html><html lang=\"fa\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:grid;place-items:center;padding:24px;color:#e7edf8;font-family:sans-serif;background:#0b1220;text-align:center}.c{max-width:430px}.ic{width:64px;height:64px;border-radius:50%;margin:0 auto 16px;background:#1e293b;display:grid;place-items:center;color:#f87171;font-size:34px;font-weight:700}h1{font-size:19px;margin-bottom:10px;color:#f1f5f9}.lay{display:inline-block;margin-bottom:10px;padding:4px 12px;border-radius:20px;border:1px solid #24334f;color:#93c5fd;font-size:12px;direction:rtl}p{color:#93a5c4;font-size:13.5px;line-height:2;margin-bottom:8px}code{direction:ltr;display:block;font-size:10.5px;color:#475569;word-break:break-all;margin-bottom:16px;max-height:52px;overflow:hidden}button{padding:13px 20px;border-radius:12px;border:0;margin:4px;background:linear-gradient(135deg,#0ea5e9,#22d3ee);color:#04121f;font-weight:700;font-size:14px;font-family:inherit}button.sec{background:#1e293b;color:#93c5fd}</style></head><body><div class=\"c\"><div class=\"ic\">!</div><h1>");
        sb.append(esc(str));
        sb.append("</h1>");
        if (str3 != null && !str3.isEmpty()) {
            sb.append("<div class=\"lay\">لایه\u200cی فعال: ");
            sb.append(esc(str3));
            sb.append("</div>");
        }
        sb.append("<p>");
        sb.append(esc(str2));
        sb.append("</p>");
        if (str4 != null && !str4.isEmpty()) {
            sb.append("<code>");
            sb.append(esc(str4));
            sb.append("</code>");
        }
        for (Btn btn : btnArr) {
            if (btn != null && !"none".equals(btn.cmd)) {
                String str6 = "sec".equals(btn.style) ? " class=\"sec\"" : "";
                String str7 = btn.cmd;
                str7.hashCode();
                switch (str7) {
                    case "reload":
                        str5 = "location.reload()";
                        break;
                    case "next":
                        str5 = "location.href='native:next-layer'";
                        break;
                    case "wake":
                        str5 = "location.href='native:wake-layers'";
                        break;
                    default:
                        str5 = "location.href='native:layers'";
                        break;
                }
                sb.append("<button");
                sb.append(str6);
                sb.append(" onclick=\"");
                sb.append(str5);
                sb.append("\">");
                sb.append(esc(btn.label));
                sb.append("</button>");
            }
        }
        sb.append("</div></body></html>");
        return sb.toString();
    }

    public static String innerOf(String str, String str2) {
        String queryParameter;
        if (str != null && str2 != null) {
            try {
                Uri parse = Uri.parse(str);
                if (parse.getHost() != null && str.startsWith(str2) && (queryParameter = parse.getQueryParameter("url")) != null) {
                    if (!queryParameter.startsWith("http://")) {
                        if (queryParameter.startsWith("https://")) {
                        }
                    }
                    return queryParameter;
                }
            } catch (Exception unused) {
            }
        }
        return null;
    }
}
