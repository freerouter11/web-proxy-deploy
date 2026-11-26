package com.freerouter.webproxy;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import com.freerouter.webproxy.ErrPage;
import com.freerouter.webproxy.Health;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/* loaded from: classes.dex */
public class MainActivity extends Activity {
    private static final long KEEPALIVE_MS = 600000;
    private static final int REQ_CAM = 7003;
    private static final int REQ_FILE = 7002;
    private static final int REQ_SERVERS = 7004;
    private static final int REQ_STORAGE = 7001;
    private static final long WATCHDOG_MS = 25000;
    private ProgressBar bar;
    private ImageButton btnBack;
    private ImageButton btnFwd;
    private ImageButton btnHome;
    private Uri cameraUri;
    private TextView chip;
    private LinearLayout chipBox;
    private ImageView chipDot;
    private String dlName;
    private String dlUa;
    private String dlUrl;
    private FrameLayout fsContainer;
    private WebChromeClient.CustomViewCallback fullscreenCb;
    private View fullscreenView;
    private ConnectivityManager.NetworkCallback netCb;
    private TextView offlineBanner;
    private LinearLayout toolbar;
    private ValueCallback<Uri[]> uploadCb;
    private WebView web;
    private static final String[] TRACKER_HOSTS = {"doubleclick.net", "googlesyndication.com", "googletagmanager.com", "google-analytics.com", "analytics.google.com", "adservice.google.com", "connect.facebook.net", "scorecardresearch.com", "quantserve.com", "hotjar.com", "clarity.ms", "mixpanel.com", "segment.io", "amplitude.com", "taboola.com", "outbrain.com", "criteo.com", "criteo.net", "adnxs.com", "rubiconproject.com", "pubmatic.com", "casalemedia.com", "openx.net", "smartadserver.net", "moatads.com", "adform.net", "yieldmo.com", "sharethrough.com", "33across.com", "liadm.com", "adsrvr.org", "amazon-adsystem.com", "propellerads.com", "popads.net", "adsterra.com", "exoclick.com", "zedo.com"};
    private static final Pattern IMG_EXT = Pattern.compile("\\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\\?|$)", 2);
    private long lastBack = 0;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean webDestroyed = false;
    private boolean bannerShown = false;
    private boolean failoverBusy = false;
    private String lastFailUrl = null;
    private boolean pageSettled = true;
    private final Runnable watchdog = new AnonymousClass1();
    private final Runnable retryOnReconnect = new AnonymousClass5();
    private final Runnable keepalive = new AnonymousClass7();

    /* renamed from: com.freerouter.webproxy.MainActivity$1, reason: invalid class name */
    class AnonymousClass1 implements Runnable {
        AnonymousClass1() {
        }

        @Override // java.lang.Runnable
        public void run() {
            if (MainActivity.this.webDestroyed || MainActivity.this.pageSettled || MainActivity.this.failoverBusy) {
                return;
            }
            MainActivity mainActivity = MainActivity.this;
            mainActivity.toast(mainActivity.getString(R.string.slow_layer_hint));
            MainActivity mainActivity2 = MainActivity.this;
            mainActivity2.failover(mainActivity2.webDestroyed ? null : MainActivity.this.web.getUrl());
        }
    }

    @Override // android.app.Activity
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        CrashHandler.install(this);
        Prefs.seedIfNeeded(this);
        getWindow().setBackgroundDrawable(new ColorDrawable(-16051680));
        setContentView(R.layout.activity_main);
        this.web = (WebView) findViewById(R.id.web);
        this.bar = (ProgressBar) findViewById(R.id.progress);
        this.offlineBanner = (TextView) findViewById(R.id.offline_banner);
        this.fsContainer = (FrameLayout) findViewById(R.id.fullscreen_container);
        this.toolbar = (LinearLayout) findViewById(R.id.toolbar);
        this.chip = (TextView) findViewById(R.id.chip_text);
        this.chipBox = (LinearLayout) findViewById(R.id.chip);
        this.chipDot = (ImageView) findViewById(R.id.chip_dot);
        this.btnBack = (ImageButton) findViewById(R.id.btn_back);
        this.btnFwd = (ImageButton) findViewById(R.id.btn_fwd);
        this.btnHome = (ImageButton) findViewById(R.id.btn_home);
        this.fsContainer.setKeepScreenOn(true);
        this.chipBox.setOnClickListener(new MainActivity$$ExternalSyntheticLambda0(this));
        this.btnBack.setOnClickListener(new MainActivity$$ExternalSyntheticLambda1(this));
        this.btnFwd.setOnClickListener(new MainActivity$$ExternalSyntheticLambda2(this));
        this.btnHome.setOnClickListener(new MainActivity$$ExternalSyntheticLambda3(this));
        findViewById(R.id.btn_servers).setOnClickListener(new MainActivity$$ExternalSyntheticLambda4(this));
        findViewById(R.id.btn_more).setOnClickListener(new MainActivity$$ExternalSyntheticLambda5(this));
        updateNav();
        WebSettings settings = this.web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(2);
        settings.setGeolocationEnabled(false);
        settings.setAllowFileAccess(false);
        if (Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(this.web, true);
        this.web.setBackgroundColor(-16051680);
        this.web.setWebViewClient(new ProxyClient(this, null));
        this.web.setWebChromeClient(new Chrome(this, null));
        this.web.setDownloadListener(new Downloads(this, null));
        setChipState(0);
        if (bundle != null) {
            this.web.restoreState(bundle);
            return;
        }
        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data == null || !"https".equals(data.getScheme())) {
            loadHome();
        } else {
            this.web.loadUrl(data.toString());
        }
    }

    /* renamed from: lambda$onCreate$0$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ void m1lambda$onCreate$0$comfreerouterwebproxyMainActivity(View view) {
        openServers();
    }

    /* renamed from: lambda$onCreate$1$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ void m2lambda$onCreate$1$comfreerouterwebproxyMainActivity(View view) {
        if (this.web.canGoBack()) {
            this.web.goBack();
        }
    }

    /* renamed from: lambda$onCreate$2$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ void m3lambda$onCreate$2$comfreerouterwebproxyMainActivity(View view) {
        if (this.web.canGoForward()) {
            this.web.goForward();
        }
    }

    /* renamed from: lambda$onCreate$3$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ void m4lambda$onCreate$3$comfreerouterwebproxyMainActivity(View view) {
        loadHome();
    }

    /* renamed from: lambda$onCreate$4$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ void m5lambda$onCreate$4$comfreerouterwebproxyMainActivity(View view) {
        openServers();
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void updateNav() {
        ImageButton imageButton = this.btnBack;
        WebView webView = this.web;
        imageButton.setEnabled((webView == null || this.webDestroyed || !webView.canGoBack()) ? false : true);
        ImageButton imageButton2 = this.btnFwd;
        WebView webView2 = this.web;
        imageButton2.setEnabled((webView2 == null || this.webDestroyed || !webView2.canGoForward()) ? false : true);
        ImageButton imageButton3 = this.btnBack;
        imageButton3.setAlpha(imageButton3.isEnabled() ? 1.0f : 0.35f);
        ImageButton imageButton4 = this.btnFwd;
        imageButton4.setAlpha(imageButton4.isEnabled() ? 1.0f : 0.35f);
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void setChipState(int i) {
        int i2 = i != 1 ? i != 2 ? i != 3 ? -10193781 : -495247 : -278748 : -13315175;
        GradientDrawable gradientDrawable = new GradientDrawable();
        gradientDrawable.setShape(1);
        gradientDrawable.setColor(i2);
        this.chipDot.setImageDrawable(gradientDrawable);
        this.chip.setText(Prefs.activeName(this));
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void setChipState(int i, String str) {
        setChipState(i);
        if (str != null) {
            this.chip.setText(str);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    /* renamed from: showMenu, reason: merged with bridge method [inline-methods] */
    public void m6lambda$onCreate$5$comfreerouterwebproxyMainActivity(View view) {
        PopupMenu popupMenu = new PopupMenu(this, view);
        popupMenu.getMenu().add(getString(R.string.menu_share));
        popupMenu.getMenu().add(getString(R.string.menu_copy));
        popupMenu.getMenu().add(getString(R.string.menu_open_browser));
        popupMenu.getMenu().add(getString(R.string.menu_remote));
        popupMenu.getMenu().add(getString(R.string.menu_configs));
        Menu menu = popupMenu.getMenu();
        Object[] objArr = new Object[1];
        objArr[0] = getString(Prefs.blockAds(this) ? R.string.state_on : R.string.state_off);
        menu.add(getString(R.string.menu_block_ads, objArr));
        Menu menu2 = popupMenu.getMenu();
        Object[] objArr2 = new Object[1];
        objArr2[0] = getString(Prefs.blockImages(this) ? R.string.state_blocked : R.string.state_shown);
        menu2.add(getString(R.string.menu_block_images, objArr2));
        popupMenu.getMenu().add(getString(R.string.menu_settings));
        popupMenu.getMenu().add(getString(R.string.menu_about));
        popupMenu.getMenu().add(getString(R.string.menu_exit));
        popupMenu.setOnMenuItemClickListener(new MainActivity$$ExternalSyntheticLambda6(this));
        popupMenu.show();
    }

    /* renamed from: lambda$showMenu$6$com-freerouter-webproxy-MainActivity, reason: not valid java name */
    /* synthetic */ boolean m7lambda$showMenu$6$comfreerouterwebproxyMainActivity(MenuItem menuItem) {
        String charSequence = menuItem.getTitle().toString();
        if (charSequence.equals(getString(R.string.menu_share))) {
            share();
        } else if (charSequence.equals(getString(R.string.menu_copy))) {
            copyLink();
        } else if (charSequence.equals(getString(R.string.menu_open_browser))) {
            openInBrowser();
        } else if (charSequence.equals(getString(R.string.menu_remote))) {
            openRemoteBrowser();
        } else if (charSequence.equals(getString(R.string.menu_configs))) {
            openConfigsPage();
        } else if (charSequence.startsWith(getString(R.string.menu_block_ads_prefix))) {
            boolean z = !Prefs.blockAds(this);
            Prefs.setBlockAds(this, z);
            Object[] objArr = new Object[1];
            objArr[0] = getString(z ? R.string.state_on : R.string.state_off);
            toast(getString(R.string.menu_block_ads, objArr));
        } else if (charSequence.startsWith(getString(R.string.menu_block_images_prefix))) {
            boolean z2 = !Prefs.blockImages(this);
            Prefs.setBlockImages(this, z2);
            Object[] objArr2 = new Object[1];
            objArr2[0] = getString(z2 ? R.string.state_blocked : R.string.state_shown);
            toast(getString(R.string.menu_block_images, objArr2));
        } else if (charSequence.equals(getString(R.string.menu_settings))) {
            startActivity(new Intent(this, (Class<?>) SettingsActivity.class));
        } else if (charSequence.equals(getString(R.string.menu_about))) {
            showAbout();
        } else {
            finish();
        }
        return true;
    }

    private String currentOrInner() {
        String url = this.webDestroyed ? null : this.web.getUrl();
        if (url == null) {
            return null;
        }
        String innerOf = ErrPage.innerOf(url, Prefs.activeUrl(this));
        if (innerOf != null) {
            return innerOf;
        }
        String lastTargetFromCookie = lastTargetFromCookie();
        return lastTargetFromCookie != null ? lastTargetFromCookie : url;
    }

    private String lastTargetFromCookie() {
        String cookie;
        try {
            String activeUrl = Prefs.activeUrl(this);
            String url = this.webDestroyed ? null : this.web.getUrl();
            if (!activeUrl.isEmpty() && url != null) {
                String host = Uri.parse(url).getHost();
                String host2 = Uri.parse(activeUrl).getHost();
                if (host == null || host2 == null || !host.equals(host2) || (cookie = CookieManager.getInstance().getCookie(activeUrl)) == null) {
                    return null;
                }
                for (String str : cookie.split(";")) {
                    String trim = str.trim();
                    if (trim.startsWith("px_last=")) {
                        String substring = trim.substring(8);
                        try {
                            substring = URLDecoder.decode(substring, "UTF-8");
                        } catch (Exception unused) {
                        }
                        if (substring.startsWith("http://") || substring.startsWith("https://")) {
                            return substring;
                        }
                    }
                }
            }
        } catch (Exception unused2) {
        }
        return null;
    }

    private void share() {
        String currentOrInner = currentOrInner();
        if (currentOrInner == null) {
            toast(getString(R.string.nothing_to_share));
            return;
        }
        try {
            Intent intent = new Intent("android.intent.action.SEND");
            intent.setType("text/plain");
            intent.putExtra("android.intent.extra.TEXT", currentOrInner);
            startActivity(Intent.createChooser(intent, getString(R.string.menu_share)));
        } catch (Exception unused) {
            toast(getString(R.string.no_app_to_open));
        }
    }

    private void copyLink() {
        String currentOrInner = currentOrInner();
        if (currentOrInner == null) {
            toast(getString(R.string.nothing_to_share));
            return;
        }
        try {
            ClipboardManager clipboardManager = (ClipboardManager) getSystemService("clipboard");
            ClipData newPlainText = ClipData.newPlainText("url", currentOrInner);
            if (clipboardManager != null) {
                clipboardManager.setPrimaryClip(newPlainText);
                toast(getString(R.string.copied));
            }
        } catch (Exception unused) {
        }
    }

    private void openInBrowser() {
        String currentOrInner = currentOrInner();
        if (currentOrInner == null) {
            toast(getString(R.string.nothing_to_share));
            return;
        }
        try {
            startActivity(new Intent("android.intent.action.VIEW", Uri.parse(currentOrInner)));
        } catch (Exception unused) {
            toast(getString(R.string.no_app_to_open));
        }
    }

    private void showAbout() {
        String str;
        try {
            str = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception unused) {
            str = "?";
        }
        new AlertDialog.Builder(this).setTitle(getString(R.string.app_name)).setMessage(getString(R.string.about_body, new Object[]{str, String.valueOf(Prefs.layers(this).size())})).setPositiveButton(R.string.ok, (DialogInterface.OnClickListener) null).show();
    }

    private class ProxyClient extends WebViewClient {
        private ProxyClient() {
        }

        /* synthetic */ ProxyClient(MainActivity mainActivity, AnonymousClass1 anonymousClass1) {
            this();
        }

        @Override // android.webkit.WebViewClient
        public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest webResourceRequest) {
            return MainActivity.this.handleUrl(webView, webResourceRequest.getUrl(), webResourceRequest.isForMainFrame());
        }

        @Override // android.webkit.WebViewClient
        public boolean shouldOverrideUrlLoading(WebView webView, String str) {
            try {
                return MainActivity.this.handleUrl(webView, Uri.parse(str), true);
            } catch (Exception unused) {
                return false;
            }
        }

        @Override // android.webkit.WebViewClient
        public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest webResourceRequest) {
            Uri url = null;
            String str = "";
            String scheme = "";
            String innerTargetOf;
            if (!Prefs.blockAds(MainActivity.this) && !Prefs.blockImages(MainActivity.this)) {
                return null;
            }
            try {
                url = webResourceRequest.getUrl();
                str = "";
                scheme = url.getScheme() == null ? "" : url.getScheme();
            } catch (Throwable unused) {
            }
            if ((!"https".equals(scheme) && !"http".equals(scheme)) || (innerTargetOf = MainActivity.innerTargetOf(url)) == null) {
                return null;
            }
            Uri parse = Uri.parse(innerTargetOf);
            String lowerCase = parse.getHost() == null ? "" : parse.getHost().toLowerCase(Locale.ROOT);
            if (Prefs.blockAds(MainActivity.this)) {
                for (String str2 : MainActivity.TRACKER_HOSTS) {
                    if (!lowerCase.equals(str2)) {
                        if (!lowerCase.endsWith("." + str2)) {
                        }
                    }
                    return blockedResponse();
                }
            }
            if (Prefs.blockImages(MainActivity.this)) {
                Pattern pattern = MainActivity.IMG_EXT;
                if (parse.getPath() != null) {
                    str = parse.getPath();
                }
                if (pattern.matcher(str).find()) {
                    return blockedResponse();
                }
            }
            return null;
        }

        private WebResourceResponse blockedResponse() {
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override // android.webkit.WebViewClient
        public void onPageStarted(WebView webView, String str, Bitmap bitmap) {
            MainActivity.this.pageSettled = false;
            MainActivity.this.main.removeCallbacks(MainActivity.this.watchdog);
            MainActivity.this.main.postDelayed(MainActivity.this.watchdog, MainActivity.WATCHDOG_MS);
        }

        @Override // android.webkit.WebViewClient
        public void onPageFinished(WebView webView, String str) {
            MainActivity.this.pageSettled = true;
            MainActivity.this.main.removeCallbacks(MainActivity.this.watchdog);
            MainActivity.this.bar.setVisibility(8);
            MainActivity.this.updateNav();
            MainActivity.this.setChipState(1);
            MainActivity.this.quickCheckActiveAsync();
        }

        @Override // android.webkit.WebViewClient
        public void onReceivedError(WebView webView, WebResourceRequest webResourceRequest, WebResourceError webResourceError) {
            if (Build.VERSION.SDK_INT >= 23) {
                if (!webResourceRequest.isForMainFrame()) {
                    return;
                }
            } else if (!String.valueOf(webResourceRequest.getUrl()).equals(webView.getUrl())) {
                return;
            }
            MainActivity.this.failover(String.valueOf(webResourceRequest.getUrl()));
        }

        @Override // android.webkit.WebViewClient
        public void onReceivedError(WebView webView, int i, String str, String str2) {
            if (str2 == null || str2.startsWith("data:") || !str2.equals(webView.getUrl())) {
                return;
            }
            MainActivity.this.failover(str2);
        }

        @Override // android.webkit.WebViewClient
        public void onReceivedHttpError(WebView webView, WebResourceRequest webResourceRequest, WebResourceResponse webResourceResponse) {
            if (Build.VERSION.SDK_INT >= 23 && webResourceRequest.isForMainFrame() && webResourceResponse != null && webResourceResponse.getStatusCode() >= 500) {
                MainActivity.this.failover(String.valueOf(webResourceRequest.getUrl()));
            }
        }

        @Override // android.webkit.WebViewClient
        public void onReceivedSslError(WebView webView, SslErrorHandler sslErrorHandler, SslError sslError) {
            sslErrorHandler.cancel();
            MainActivity mainActivity = MainActivity.this;
            mainActivity.showErr(mainActivity.getString(R.string.ssl_error_title), MainActivity.this.getString(R.string.ssl_error_desc), null);
        }

        @Override // android.webkit.WebViewClient
        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail renderProcessGoneDetail) {
            if (MainActivity.this.fullscreenView != null) {
                MainActivity.this.exitFullscreen();
            }
            MainActivity mainActivity = MainActivity.this;
            mainActivity.toast(mainActivity.getString(R.string.renderer_crash));
            MainActivity.this.webDestroyed = true;
            ViewGroup viewGroup = (ViewGroup) MainActivity.this.web.getParent();
            if (viewGroup != null) {
                viewGroup.removeView(MainActivity.this.web);
            }
            try {
                MainActivity.this.web.destroy();
            } catch (Throwable unused) {
            }
            MainActivity.this.recreate();
            return true;
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public boolean handleUrl(WebView webView, Uri uri, boolean z) {
        String lowerCase = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("http".equals(lowerCase) || "https".equals(lowerCase)) {
            if (uri.getQueryParameter("add-backend") != null) {
                handleAddBackend(uri);
                return true;
            }
            if (z && !isLayerHost(uri.getHost())) {
                String activeUrl = Prefs.activeUrl(this);
                if (!activeUrl.isEmpty()) {
                    webView.loadUrl(activeUrl + "/proxy?url=" + Uri.encode(uri.toString()) + "&pxo=1");
                    return true;
                }
            }
            return false;
        }
        if ("native".equals(lowerCase)) {
            String valueOf = String.valueOf(uri.getSchemeSpecificPart());
            if (valueOf.startsWith("next-layer")) {
                failoverNext();
            } else if (valueOf.startsWith("wake-layers")) {
                wakeAll();
            } else if (valueOf.startsWith("layers")) {
                openServers();
            }
            return true;
        }
        if ("file".equals(lowerCase)) {
            return true;
        }
        if ("data".equals(lowerCase) || "blob".equals(lowerCase) || "about".equals(lowerCase)) {
            return false;
        }
        if ("intent".equals(lowerCase)) {
            try {
                try {
                    Intent parseUri = Intent.parseUri(uri.toString(), 1);
                    parseUri.addCategory("android.intent.category.BROWSABLE");
                    parseUri.setComponent(null);
                    startActivity(parseUri);
                } catch (Exception unused) {
                    String queryParameter = uri.getQueryParameter("browser_fallback_url");
                    if (queryParameter != null) {
                        this.web.loadUrl(queryParameter);
                    }
                }
            } catch (Exception unused2) {
            }
            return true;
        }
        try {
            startActivity(new Intent("android.intent.action.VIEW", uri));
        } catch (Exception unused3) {
            toast(getString(R.string.no_app_to_open));
        }
        return true;
    }

    private boolean isLayerHost(String str) {
        if (str == null) {
            return true;
        }
        Iterator<String[]> it = Prefs.layers(this).iterator();
        while (it.hasNext()) {
            if (str.equals(Uri.parse(it.next()[1]).getHost())) {
                return true;
            }
        }
        return false;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public static String innerTargetOf(Uri uri) {
        try {
            String queryParameter = uri.getQueryParameter("url");
            if (queryParameter == null) {
                return null;
            }
            if (!queryParameter.startsWith("http://")) {
                if (!queryParameter.startsWith("https://")) {
                    return null;
                }
            }
            return queryParameter;
        } catch (Exception unused) {
            return null;
        }
    }

    private void handleAddBackend(Uri uri) {
        String trim;
        String str;
        String host;
        try {
            String queryParameter = uri.getQueryParameter("add-backend");
            if (queryParameter == null) {
                queryParameter = uri.getQueryParameter("add_backend");
            }
            if (queryParameter == null) {
                return;
            }
            String[] split = queryParameter.split("\\|");
            if (split.length >= 2) {
                host = split[0].trim();
                trim = split[1].trim();
            } else {
                trim = queryParameter.trim();
                if (trim.startsWith("http")) {
                    str = trim;
                } else {
                    str = "https://" + trim;
                }
                host = Uri.parse(str).getHost();
            }
            if (!trim.startsWith("http://") && !trim.startsWith("https://")) {
                trim = "https://" + trim;
            }
            while (trim.endsWith("/")) {
                trim = trim.substring(0, trim.length() - 1);
            }
            if (Uri.parse(trim).getHost() == null) {
                toast(getString(R.string.invalid_layer));
                return;
            }
            if (host == null || host.isEmpty()) {
                host = Uri.parse(trim).getHost();
            }
            if (Prefs.addLayer(this, host, trim)) {
                toast(getString(R.string.layer_active_now, new Object[]{host}));
                openServers();
            } else {
                toast(getString(R.string.layer_exists));
            }
        } catch (Exception unused) {
            toast(getString(R.string.invalid_layer));
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void failover(String str) {
        if (this.failoverBusy) {
            return;
        }
        if (str != null && str.equals(this.lastFailUrl)) {
            showErr(getString(R.string.conn_error_title), getString(R.string.conn_error_desc), str);
            return;
        }
        this.lastFailUrl = str;
        if (this.bannerShown) {
            showErr(getString(R.string.conn_error_title), getString(R.string.conn_error_desc), str);
            return;
        }
        this.failoverBusy = true;
        setChipState(3);
        String innerOf = ErrPage.innerOf(str, Prefs.activeUrl(this));
        if (innerOf == null) {
            innerOf = lastTargetFromCookie();
        }
        List<String[]> layers = Prefs.layers(this);
        ArrayList arrayList = new ArrayList();
        Iterator<String[]> it = layers.iterator();
        while (it.hasNext()) {
            arrayList.add(it.next()[1]);
        }
        Health.testAll(arrayList, this.main, new AnonymousClass2(layers, innerOf, str));
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$2, reason: invalid class name */
    class AnonymousClass2 implements Health.Listener {
        final /* synthetic */ String val$failingUrl;
        final /* synthetic */ String val$innerF;
        final /* synthetic */ List val$layers;

        @Override // com.freerouter.webproxy.Health.Listener
        public void onLayer(int i, String str, int i2, int i3) {
        }

        AnonymousClass2(List list, String str, String str2) {
            this.val$layers = list;
            this.val$innerF = str;
            this.val$failingUrl = str2;
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onFirstAwake(int i, int i2) {
            if (i != Prefs.active(MainActivity.this)) {
                Prefs.setActive(MainActivity.this, i);
                MainActivity mainActivity = MainActivity.this;
                mainActivity.toast(mainActivity.getString(R.string.switched_to, new Object[]{((String[]) this.val$layers.get(i))[0]}));
            }
            MainActivity.this.setChipState(1);
            MainActivity.this.failoverBusy = false;
            MainActivity.this.loadWithInner(this.val$innerF);
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onAllDone(int i, int i2) {
            if (i < 0) {
                MainActivity.this.failoverBusy = false;
                MainActivity.this.setChipState(3);
                MainActivity mainActivity = MainActivity.this;
                mainActivity.showErr(mainActivity.getString(R.string.conn_error_title), MainActivity.this.getString(R.string.conn_error_desc), this.val$failingUrl);
            }
        }
    }

    private void failoverNext() {
        List<String[]> layers = Prefs.layers(this);
        if (layers.isEmpty()) {
            return;
        }
        String innerOf = ErrPage.innerOf(this.webDestroyed ? null : this.web.getUrl(), Prefs.activeUrl(this));
        if (innerOf == null) {
            innerOf = lastTargetFromCookie();
        }
        Prefs.setActive(this, (Prefs.active(this) + 1) % layers.size());
        setChipState(2, layers.get(Prefs.active(this))[0]);
        loadWithInner(innerOf);
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void loadWithInner(String str) {
        String activeUrl = Prefs.activeUrl(this);
        if (str != null && !str.isEmpty()) {
            this.web.loadUrl(activeUrl + "/proxy?url=" + Uri.encode(str) + "&pxo=1");
        } else {
            this.web.loadUrl(activeUrl);
        }
        this.lastFailUrl = null;
    }

    private void wakeAll() {
        setChipState(2, getString(R.string.chip_waking));
        ArrayList arrayList = new ArrayList();
        Iterator<String[]> it = Prefs.layers(this).iterator();
        while (it.hasNext()) {
            arrayList.add(it.next()[1]);
        }
        Health.testAll(arrayList, this.main, new AnonymousClass3());
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$3, reason: invalid class name */
    class AnonymousClass3 implements Health.Listener {
        AnonymousClass3() {
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onLayer(int i, String str, int i2, int i3) {
            if ("ok".equals(str)) {
                MainActivity.this.setChipState(1);
            } else if ("wake".equals(str)) {
                MainActivity.this.setChipState(2);
            }
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onFirstAwake(int i, int i2) {
            Prefs.setActive(MainActivity.this, i);
            MainActivity.this.failoverBusy = false;
            MainActivity.this.web.loadUrl(Prefs.activeUrl(MainActivity.this));
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onAllDone(int i, int i2) {
            MainActivity.this.failoverBusy = false;
            if (i < 0) {
                MainActivity.this.setChipState(3);
                MainActivity mainActivity = MainActivity.this;
                mainActivity.toast(mainActivity.getString(R.string.all_layers_down));
            }
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void quickCheckActiveAsync() {
        String activeUrl = Prefs.activeUrl(this);
        if (activeUrl.isEmpty()) {
            return;
        }
        new AnonymousClass4(activeUrl).start();
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$4, reason: invalid class name */
    class AnonymousClass4 extends Thread {
        final /* synthetic */ String val$base;

        AnonymousClass4(String str) {
            this.val$base = str;
        }

        @Override // java.lang.Thread, java.lang.Runnable
        public void run() {
            int probeMs = Health.probeMs(this.val$base, 4000);
            if (probeMs >= 0) {
                Prefs.setLastMs(MainActivity.this, this.val$base, probeMs);
                MainActivity.this.main.post(new MainActivity$4$$ExternalSyntheticLambda0(this, probeMs));
            }
        }

        /* renamed from: lambda$run$0$com-freerouter-webproxy-MainActivity$4, reason: not valid java name */
        /* synthetic */ void m8lambda$run$0$comfreerouterwebproxyMainActivity$4(int i) {
            if (MainActivity.this.webDestroyed) {
                return;
            }
            MainActivity.this.setChipState(1, Prefs.activeName(MainActivity.this) + " · " + MainActivity.faDigits(i) + " م\u200cث");
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public static String faDigits(int i) {
        String valueOf = String.valueOf(i);
        StringBuilder sb = new StringBuilder();
        for (char c : valueOf.toCharArray()) {
            if (c >= '0' && c <= '9') {
                sb.append((char) (c + 1728));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private void loadHome() {
        String activeUrl = Prefs.activeUrl(this);
        if (activeUrl.isEmpty()) {
            Prefs.seedIfNeeded(this);
            activeUrl = Prefs.activeUrl(this);
        }
        this.web.loadUrl(activeUrl);
    }

    private void openServers() {
        startActivityForResult(new Intent(this, (Class<?>) ServersActivity.class), REQ_SERVERS);
    }

    private void openRemoteBrowser() {
        String activeUrl = Prefs.activeUrl(this);
        if (activeUrl.isEmpty()) {
            Prefs.seedIfNeeded(this);
            activeUrl = Prefs.activeUrl(this);
        }
        while (activeUrl.endsWith("/")) {
            activeUrl = activeUrl.substring(0, activeUrl.length() - 1);
        }
        this.web.loadUrl(activeUrl + "/remote");
    }

    private void openConfigsPage() {
        String activeUrl = Prefs.activeUrl(this);
        if (activeUrl.isEmpty()) {
            Prefs.seedIfNeeded(this);
            activeUrl = Prefs.activeUrl(this);
        }
        while (activeUrl.endsWith("/")) {
            activeUrl = activeUrl.substring(0, activeUrl.length() - 1);
        }
        this.web.loadUrl(activeUrl + "/configs");
    }

    /* JADX INFO: Access modifiers changed from: private */
    class Chrome extends WebChromeClient {
        private Chrome() {
        }

        /* synthetic */ Chrome(MainActivity mainActivity, AnonymousClass1 anonymousClass1) {
            this();
        }

        @Override // android.webkit.WebChromeClient
        public void onProgressChanged(WebView webView, int i) {
            if (i >= 100) {
                MainActivity.this.bar.setVisibility(8);
            } else {
                MainActivity.this.bar.setVisibility(0);
                MainActivity.this.bar.setProgress(i);
            }
        }

        @Override // android.webkit.WebChromeClient
        public void onShowCustomView(View view, WebChromeClient.CustomViewCallback customViewCallback) {
            if (MainActivity.this.fullscreenView != null) {
                customViewCallback.onCustomViewHidden();
                return;
            }
            MainActivity.this.fullscreenView = view;
            MainActivity.this.fullscreenCb = customViewCallback;
            MainActivity.this.fsContainer.addView(view, new FrameLayout.LayoutParams(-1, -1));
            MainActivity.this.fsContainer.setVisibility(0);
            MainActivity.this.toolbar.setVisibility(8);
            MainActivity.this.web.setVisibility(4);
            MainActivity.this.bar.setVisibility(8);
            MainActivity.this.hideSystemBars();
        }

        @Override // android.webkit.WebChromeClient
        public void onHideCustomView() {
            MainActivity.this.exitFullscreen();
        }

        @Override // android.webkit.WebChromeClient
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> valueCallback, WebChromeClient.FileChooserParams fileChooserParams) {
            if (MainActivity.this.uploadCb != null) {
                MainActivity.this.uploadCb.onReceiveValue(null);
            }
            MainActivity.this.uploadCb = valueCallback;
            boolean[] zArr = {false};
            new AlertDialog.Builder(MainActivity.this).setTitle(R.string.choose_upload_title).setPositiveButton(R.string.upload_files, new MainActivity$Chrome$$ExternalSyntheticLambda0(this, zArr, fileChooserParams)).setNeutralButton(R.string.upload_camera, new MainActivity$Chrome$$ExternalSyntheticLambda1(this, zArr)).setNegativeButton(R.string.cancel, new MainActivity$Chrome$$ExternalSyntheticLambda2(this, zArr)).setOnCancelListener(new MainActivity$Chrome$$ExternalSyntheticLambda3(this, zArr)).show();
            return true;
        }

        /* renamed from: lambda$onShowFileChooser$0$com-freerouter-webproxy-MainActivity$Chrome, reason: not valid java name */
        /* synthetic */ void m11xcc94249d(boolean[] zArr, WebChromeClient.FileChooserParams fileChooserParams, DialogInterface dialogInterface, int i) {
            zArr[0] = true;
            try {
                Intent createIntent = fileChooserParams.createIntent();
                MainActivity mainActivity = MainActivity.this;
                mainActivity.startActivityForResult(Intent.createChooser(createIntent, mainActivity.getString(R.string.upload_files)), MainActivity.REQ_FILE);
            } catch (Exception unused) {
                MainActivity.this.finishUpload(null);
            }
        }

        /* renamed from: lambda$onShowFileChooser$1$com-freerouter-webproxy-MainActivity$Chrome, reason: not valid java name */
        /* synthetic */ void m12x6734e71e(boolean[] zArr, DialogInterface dialogInterface, int i) {
            zArr[0] = true;
            MainActivity.this.launchCamera();
        }

        /* renamed from: lambda$onShowFileChooser$2$com-freerouter-webproxy-MainActivity$Chrome, reason: not valid java name */
        /* synthetic */ void m13x1d5a99f(boolean[] zArr, DialogInterface dialogInterface, int i) {
            zArr[0] = true;
            MainActivity.this.finishUpload(null);
        }

        /* renamed from: lambda$onShowFileChooser$3$com-freerouter-webproxy-MainActivity$Chrome, reason: not valid java name */
        /* synthetic */ void m14x9c766c20(boolean[] zArr, DialogInterface dialogInterface) {
            if (zArr[0]) {
                return;
            }
            MainActivity.this.finishUpload(null);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void launchCamera() {
        try {
            File file = new File(getCacheDir(), "captures");
            if (!file.exists()) {
                file.mkdirs();
            }
            File file2 = new File(file, "cap_" + System.currentTimeMillis() + ".jpg");
            StringBuilder sb = new StringBuilder("content://com.freerouter.webproxy.cam/captures/");
            sb.append(file2.getName());
            this.cameraUri = Uri.parse(sb.toString());
            Intent intent = new Intent("android.media.action.IMAGE_CAPTURE");
            intent.putExtra("output", this.cameraUri);
            intent.setClipData(ClipData.newRawUri("output", this.cameraUri));
            intent.addFlags(3);
            startActivityForResult(intent, REQ_CAM);
        } catch (Exception unused) {
            finishUpload(null);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void finishUpload(Uri[] uriArr) {
        ValueCallback<Uri[]> valueCallback = this.uploadCb;
        if (valueCallback != null) {
            valueCallback.onReceiveValue(uriArr);
            this.uploadCb = null;
        }
    }

    private class Downloads implements DownloadListener {
        private Downloads() {
        }

        /* synthetic */ Downloads(MainActivity mainActivity, AnonymousClass1 anonymousClass1) {
            this();
        }

        @Override // android.webkit.DownloadListener
        public void onDownloadStart(String str, String str2, String str3, String str4, long j) {
            MainActivity.this.dlUrl = str;
            MainActivity.this.dlUa = str2;
            MainActivity.this.dlName = MainActivity.fileNameFrom(str3, str, str4);
            if (Build.VERSION.SDK_INT >= 29 || MainActivity.this.checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE") == 0) {
                MainActivity.this.startDownload();
            } else {
                MainActivity.this.requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, MainActivity.REQ_STORAGE);
            }
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void startDownload() {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(this.dlUrl));
            request.setNotificationVisibility(1);
            request.setTitle(this.dlName);
            String cookie = CookieManager.getInstance().getCookie(this.dlUrl);
            if (cookie != null) {
                request.addRequestHeader("Cookie", cookie);
            }
            String str = this.dlUa;
            if (str != null) {
                request.addRequestHeader("User-Agent", str);
            }
            if (Build.VERSION.SDK_INT >= 29) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, this.dlName);
            } else {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, this.dlName);
            }
            DownloadManager downloadManager = (DownloadManager) getSystemService("download");
            if (downloadManager != null) {
                downloadManager.enqueue(request);
                toast(getString(R.string.download_started));
            }
        } catch (Exception unused) {
            toast(getString(R.string.download_failed));
        }
        this.dlUa = null;
        this.dlName = null;
        this.dlUrl = null;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public static String fileNameFrom(String str, String str2, String str3) {
        if (str != null) {
            try {
                Matcher matcher = Pattern.compile("filename\\*=(?:UTF-8|utf-8)''([^;]+)").matcher(str);
                if (matcher.find()) {
                    return sanitize(URLDecoder.decode(matcher.group(1), "UTF-8"));
                }
            } catch (Exception unused) {
            }
            Matcher matcher2 = Pattern.compile("filename=\"?([^\";]+)\"?").matcher(str);
            if (matcher2.find()) {
                return sanitize(matcher2.group(1).trim());
            }
        }
        try {
            Uri parse = Uri.parse(str2);
            String queryParameter = parse.getQueryParameter("url");
            if (queryParameter != null) {
                String lastPathSegment = Uri.parse(queryParameter).getLastPathSegment();
                if (lastPathSegment != null && lastPathSegment.contains(".")) {
                    return sanitize(lastPathSegment);
                }
            }
            String lastPathSegment2 = parse.getLastPathSegment();
            if (lastPathSegment2 != null && lastPathSegment2.contains(".")) {
                return sanitize(lastPathSegment2);
            }
        } catch (Exception unused2) {
        }
        return "download" + extOf(str3);
    }

    private static String sanitize(String str) {
        String trim = str.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (trim.length() > 120) {
            trim = trim.substring(trim.length() - 120);
        }
        if (!trim.isEmpty() && !trim.startsWith(".")) {
            return trim;
        }
        return "_" + trim;
    }

    private static String extOf(String str) {
        if (str == null) {
            return ".bin";
        }
        String lowerCase = str.toLowerCase(Locale.ROOT);
        if (lowerCase.contains("pdf")) {
            return ".pdf";
        }
        if (lowerCase.contains("jpeg") || lowerCase.contains("jpg")) {
            return ".jpg";
        }
        if (lowerCase.contains("png")) {
            return ".png";
        }
        if (lowerCase.contains("gif")) {
            return ".gif";
        }
        if (lowerCase.contains("webp")) {
            return ".webp";
        }
        if (lowerCase.contains("mp4")) {
            return ".mp4";
        }
        if (lowerCase.contains("webm")) {
            return ".webm";
        }
        if (lowerCase.contains("mpeg") || lowerCase.contains("mp3")) {
            return ".mp3";
        }
        return lowerCase.contains("ogg") ? ".ogg" : lowerCase.contains("zip") ? ".zip" : lowerCase.contains("rar") ? ".rar" : lowerCase.contains("json") ? ".json" : ".bin";
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
        } else {
            getWindow().getDecorView().setSystemUiVisibility(5894);
        }
    }

    private void showSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(true);
            getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        } else {
            getWindow().getDecorView().setSystemUiVisibility(0);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void exitFullscreen() {
        if (this.fullscreenView == null) {
            return;
        }
        this.fsContainer.removeAllViews();
        this.fsContainer.setVisibility(8);
        this.toolbar.setVisibility(0);
        this.web.setVisibility(0);
        showSystemBars();
        this.fullscreenView = null;
        WebChromeClient.CustomViewCallback customViewCallback = this.fullscreenCb;
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            this.fullscreenCb = null;
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void showErr(String str, String str2, String str3) {
        String build = ErrPage.build(str, str2, Prefs.activeName(this), str3, new ErrPage.Btn[]{new ErrPage.Btn(getString(R.string.retry), "reload", "primary"), new ErrPage.Btn(getString(R.string.next_layer), "next", "sec"), new ErrPage.Btn(getString(R.string.wake_layers), "wake", "sec"), new ErrPage.Btn(getString(R.string.manage_layers), "layers", "sec")});
        if (str3 == null) {
            str3 = Prefs.activeUrl(this);
        }
        String str4 = str3;
        this.web.loadDataWithBaseURL(str4, build, "text/html; charset=utf-8", "utf-8", str4);
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$5, reason: invalid class name */
    class AnonymousClass5 implements Runnable {
        AnonymousClass5() {
        }

        @Override // java.lang.Runnable
        public void run() {
            if (MainActivity.this.webDestroyed || MainActivity.this.web.getUrl() == null) {
                return;
            }
            MainActivity.this.web.reload();
        }
    }

    private void watchNetwork() {
        if (Build.VERSION.SDK_INT < 24) {
            return;
        }
        try {
            ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService("connectivity");
            if (connectivityManager == null) {
                return;
            }
            if (this.netCb == null) {
                this.netCb = new AnonymousClass6();
            }
            connectivityManager.registerDefaultNetworkCallback(this.netCb);
        } catch (Exception unused) {
        }
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$6, reason: invalid class name */
    class AnonymousClass6 extends ConnectivityManager.NetworkCallback {
        AnonymousClass6() {
        }

        @Override // android.net.ConnectivityManager.NetworkCallback
        public void onLost(Network network) {
            MainActivity.this.main.postDelayed(new MainActivity$6$$ExternalSyntheticLambda0(this), 1500L);
        }

        /* renamed from: lambda$onLost$0$com-freerouter-webproxy-MainActivity$6, reason: not valid java name */
        /* synthetic */ void m10lambda$onLost$0$comfreerouterwebproxyMainActivity$6() {
            ConnectivityManager connectivityManager = (ConnectivityManager) MainActivity.this.getSystemService("connectivity");
            if (connectivityManager == null || connectivityManager.getActiveNetwork() != null || MainActivity.this.bannerShown) {
                return;
            }
            MainActivity.this.bannerShown = true;
            MainActivity.this.offlineBanner.setVisibility(0);
        }

        @Override // android.net.ConnectivityManager.NetworkCallback
        public void onCapabilitiesChanged(Network network, NetworkCapabilities networkCapabilities) {
            if ((networkCapabilities.hasCapability(12) || networkCapabilities.hasCapability(16)) && MainActivity.this.bannerShown) {
                MainActivity.this.bannerShown = false;
                MainActivity.this.main.post(new MainActivity$6$$ExternalSyntheticLambda1(this));
            }
        }

        /* renamed from: lambda$onCapabilitiesChanged$1$com-freerouter-webproxy-MainActivity$6, reason: not valid java name */
        /* synthetic */ void m9x681ee176() {
            MainActivity.this.offlineBanner.setVisibility(8);
            MainActivity.this.main.postDelayed(MainActivity.this.retryOnReconnect, 1200L);
        }
    }

    /* renamed from: com.freerouter.webproxy.MainActivity$7, reason: invalid class name */
    class AnonymousClass7 implements Runnable {
        AnonymousClass7() {
        }

        @Override // java.lang.Runnable
        public void run() {
            if (MainActivity.this.webDestroyed || !Prefs.keepAlive(MainActivity.this)) {
                return;
            }
            Iterator<String[]> it = Prefs.layers(MainActivity.this).iterator();
            while (it.hasNext()) {
                Health.silentPing(it.next()[1]);
            }
            MainActivity.this.main.postDelayed(this, MainActivity.KEEPALIVE_MS);
        }
    }

    @Override // android.app.Activity
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri data = intent.getData();
        if (data == null) {
            return;
        }
        if ("https".equals(data.getScheme()) || "http".equals(data.getScheme())) {
            if (data.getQueryParameter("add-backend") != null) {
                handleAddBackend(data);
                return;
            }
            if (!isLayerHost(data.getHost())) {
                String activeUrl = Prefs.activeUrl(this);
                if (!activeUrl.isEmpty()) {
                    this.web.loadUrl(activeUrl + "/proxy?url=" + Uri.encode(data.toString()));
                    return;
                }
            }
            this.web.loadUrl(data.toString());
        }
    }

    @Override // android.app.Activity
    protected void onStart() {
        super.onStart();
        watchNetwork();
    }

    @Override // android.app.Activity
    protected void onStop() {
        if (this.netCb != null) {
            try {
                ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService("connectivity");
                if (connectivityManager != null) {
                    connectivityManager.unregisterNetworkCallback(this.netCb);
                }
            } catch (Exception unused) {
            }
        }
        super.onStop();
    }

    @Override // android.app.Activity
    protected void onResume() {
        super.onResume();
        if (!this.webDestroyed) {
            this.web.onResume();
        }
        if (Prefs.keepAlive(this)) {
            this.main.postDelayed(this.keepalive, KEEPALIVE_MS);
        }
    }

    @Override // android.app.Activity
    protected void onPause() {
        this.main.removeCallbacks(this.keepalive);
        this.main.removeCallbacks(this.retryOnReconnect);
        if (!this.webDestroyed) {
            this.web.onPause();
        }
        super.onPause();
    }

    @Override // android.app.Activity
    protected void onSaveInstanceState(Bundle bundle) {
        super.onSaveInstanceState(bundle);
        if (this.webDestroyed) {
            return;
        }
        this.web.saveState(bundle);
    }

    @Override // android.app.Activity
    protected void onDestroy() {
        WebView webView;
        this.main.removeCallbacks(this.watchdog);
        if (!this.webDestroyed && (webView = this.web) != null) {
            this.webDestroyed = true;
            try {
                ViewGroup viewGroup = (ViewGroup) webView.getParent();
                if (viewGroup != null) {
                    viewGroup.removeView(this.web);
                }
                this.web.destroy();
            } catch (Throwable unused) {
            }
        }
        super.onDestroy();
    }

    @Override // android.app.Activity
    public void onRequestPermissionsResult(int i, String[] strArr, int[] iArr) {
        super.onRequestPermissionsResult(i, strArr, iArr);
        if (i != REQ_STORAGE || this.dlUrl == null) {
            return;
        }
        if (iArr.length > 0 && iArr[0] == 0) {
            startDownload();
        } else {
            this.dlUrl = null;
            toast(getString(R.string.download_failed));
        }
    }

    @Override // android.app.Activity
    protected void onActivityResult(int i, int i2, Intent intent) {
        Uri uri;
        super.onActivityResult(i, i2, intent);
        Uri[] uriArr = null;
        if (i == REQ_FILE) {
            if (i2 == -1 && (((uriArr = WebChromeClient.FileChooserParams.parseResult(i2, intent)) == null || uriArr.length == 0) && intent != null && intent.getData() != null)) {
                uriArr = new Uri[]{intent.getData()};
            }
            finishUpload(uriArr);
            return;
        }
        if (i == REQ_CAM) {
            Uri[] uriArr2 = (i2 != -1 || (uri = this.cameraUri) == null) ? null : new Uri[]{uri};
            this.cameraUri = null;
            finishUpload(uriArr2);
        } else if (i == REQ_SERVERS) {
            setChipState(0);
            String url = this.webDestroyed ? null : this.web.getUrl();
            if (url == null || !url.startsWith(Prefs.activeUrl(this))) {
                loadHome();
            }
        }
    }

    @Override // android.app.Activity
    public void onBackPressed() {
        if (this.fullscreenView != null) {
            exitFullscreen();
            return;
        }
        if (!this.webDestroyed && this.web.canGoBack()) {
            this.web.goBack();
            return;
        }
        long elapsedRealtime = SystemClock.elapsedRealtime();
        if (elapsedRealtime - this.lastBack < 2000) {
            super.onBackPressed();
        } else {
            this.lastBack = elapsedRealtime;
            toast(getString(R.string.exit_hint));
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void toast(String str) {
        try {
            Toast.makeText(this, str, 0).show();
        } catch (Throwable unused) {
        }
    }
}
