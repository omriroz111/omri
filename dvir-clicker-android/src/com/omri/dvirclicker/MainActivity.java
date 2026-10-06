package com.omri.dvirclicker;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;

/** Runs the Dvir Clicker web game (bundled under assets/www) in a full-screen WebView. */
public class MainActivity extends Activity {
    // Host reserved for serving app-local content (the one androidx WebViewAssetLoader uses),
    // so the game runs on a normal https origin and its localStorage save persists.
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#120e26"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        // Rapid tapping must never turn into text selection or a long-press buzz.
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);
        webView.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                return true;
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.addJavascriptInterface(new Bridge(this), "DvirAndroid");
        webView.setWebViewClient(new LocalAssetClient());
        setContentView(webView);
        webView.loadUrl(START_URL);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        hideSystemBars();
    }

    @Override
    protected void onPause() {
        // The page saves on its own every few seconds; this catches the last clicks.
        webView.evaluateJavascript("window.dvirSave && window.dvirSave()", null);
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    private static String mimeType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".txt")) return "text/plain";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /** Serves https://appassets.androidplatform.net/... from assets/www and blocks everything else. */
    private final class LocalAssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String path = url.getPath();
            if (!HOST.equals(url.getHost()) || path == null || path.contains("..")) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
            }
            if (path.isEmpty() || path.endsWith("/")) path += "index.html";
            try {
                InputStream in = getAssets().open("www" + path);
                String mime = mimeType(path);
                return new WebResourceResponse(mime, mime.startsWith("text/") ? "UTF-8" : null, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !HOST.equals(request.getUrl().getHost());
        }
    }

    /** Exposed to the page as window.DvirAndroid. */
    public static final class Bridge {
        private final Vibrator vibrator;

        Bridge(Context context) {
            vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
        }

        /** "10" buzzes once for 10ms; "40,50,40" alternates on/off/on in ms. */
        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void vibrate(String pattern) {
            if (vibrator == null || !vibrator.hasVibrator() || pattern == null) return;
            long[] parts;
            try {
                String[] raw = pattern.split(",");
                parts = new long[raw.length];
                for (int i = 0; i < raw.length; i++) {
                    parts[i] = Math.max(0, Math.min(1000, Long.parseLong(raw[i].trim())));
                }
            } catch (NumberFormatException e) {
                return;
            }

            if (parts.length == 1) {
                long ms = parts[0];
                if (ms <= 0) return;
                if (Build.VERSION.SDK_INT >= 29 && ms <= 30) {
                    // Crisp system haptics feel much better than a tiny motor pulse.
                    vibrator.vibrate(VibrationEffect.createPredefined(
                            ms <= 20 ? VibrationEffect.EFFECT_CLICK : VibrationEffect.EFFECT_HEAVY_CLICK));
                } else if (Build.VERSION.SDK_INT >= 26) {
                    vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(ms);
                }
                return;
            }

            // Android patterns start with an "off" delay; the page's start with "on".
            long[] timings = new long[parts.length + 1];
            System.arraycopy(parts, 0, timings, 1, parts.length);
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, -1));
            } else {
                vibrator.vibrate(timings, -1);
            }
        }
    }
}
