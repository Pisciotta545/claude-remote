package com.claude.remote;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    private WebView web;
    private SharedPreferences prefs;
    private String pendingPath; // proyecto a abrir al tocar una notificación
    private ValueCallback<Uri[]> fileCallback; // selector de archivos del botón "Adjuntar"
    private static final int REQ_FILES = 200;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        if (getIntent() != null) pendingPath = getIntent().getStringExtra("path");
        String url = prefs.getString("url", null);
        if (url == null) showConfig();
        else showWeb(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getStringExtra("path") != null) {
            pendingPath = intent.getStringExtra("path");
            maybeOpenPending();
        }
    }

    /** Si hay un proyecto pendiente (de una notificación), lo abre en la web. */
    private void maybeOpenPending() {
        if (pendingPath == null || web == null) return;
        final String p = pendingPath;
        pendingPath = null;
        web.post(() -> web.evaluateJavascript(
            "window.__crOpenProject && window.__crOpenProject(" + JSONObject.quote(p) + ");", null));
    }

    private void showConfig() {
        setContentView(R.layout.config);
        final EditText input = (EditText) findViewById(R.id.serverUrl);
        input.setText(prefs.getString("url", ""));
        Button save = (Button) findViewById(R.id.saveBtn);
        save.setOnClickListener(v -> {
            String raw = input.getText().toString().trim();
            if (raw.isEmpty()) {
                Toast.makeText(this, "Ingresá una dirección", Toast.LENGTH_SHORT).show();
                return;
            }
            if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw = "http://" + raw;
            prefs.edit().putString("url", raw).apply();
            showWeb(raw);
        });
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showWeb(String url) {
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Sin WebChromeClient, los diálogos JS (confirm/alert) no funcionan y
        // confirm() devuelve false → el botón "Cerrar" no hacía nada.
        web.setWebChromeClient(new WebChromeClient() {
            // Sin esto, <input type="file"> ("Adjuntar") no abre nada en el WebView.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, "Adjuntar"), REQ_FILES);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        // Puente nativo para abrir links afuera y copiar/pegar con el portapapeles
        // del sistema (más fiable que las APIs web sobre HTTP local).
        web.addJavascriptInterface(new NativeBridge(), "CRNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest req) {
                // Todo lo que no sea el servidor propio (links tocados) va afuera,
                // así la app no se reemplaza ni expone el puente nativo a otros sitios.
                Uri target = req.getUrl();
                Uri base = Uri.parse(baseUrl());
                String host = target.getHost();
                if (host != null && host.equalsIgnoreCase(base.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, target)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No se pudo abrir el link", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                maybeOpenPending(); // abre el proyecto de la notificación si lo hay
            }
        });
        web.loadUrl(url);
        checkUpdate(false);   // chequeo silencioso al abrir
        ensureNotifications(); // permiso de notificaciones (Android 13+)
        registerPush();        // registra el token FCM en el servidor
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) { // selección múltiple
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int k = 0; k < n; k++) result[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // --- Notificaciones push -----------------------------------------------

    /** Pide el permiso de notificaciones en Android 13+ (antes no hace falta). */
    private void ensureNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }

    /** Obtiene el token FCM y lo manda al servidor configurado. */
    private void registerPush() {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful() && task.getResult() != null) {
                PushService.sendTokenToServer(this, task.getResult());
            }
        });
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Cambiar servidor");
        menu.add(0, 2, 0, "Buscar actualización");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            showConfig();
            return true;
        }
        if (item.getItemId() == 2) {
            checkUpdate(true);
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        // Si la web está dentro de un proyecto, el botón físico vuelve al selector
        // (sin cerrar la app ni cortar la sesión). Si ya está en el selector, sale.
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.__crInProject === true", value -> {
            if ("true".equals(value)) {
                web.evaluateJavascript("window.__crGoBack && window.__crGoBack();", null);
            } else {
                finish();
            }
        });
    }

    // --- Autoactualización -------------------------------------------------

    private String baseUrl() {
        String u = prefs.getString("url", "");
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    /** Consulta la versión del servidor. Si es más nueva, ofrece instalarla. */
    private void checkUpdate(boolean manual) {
        final String base = baseUrl();
        if (base.isEmpty()) return;
        new Thread(() -> {
            try {
                JSONObject info = new JSONObject(httpGet(base + "/api/app-version"));
                int remote = info.getInt("versionCode");
                String name = info.optString("versionName", "?");
                String apkUrl = base + info.optString("url", "/download/app.apk");
                if (remote > BuildConfig.VERSION_CODE) {
                    runOnUiThread(() -> promptInstall(name, apkUrl));
                } else if (manual) {
                    runOnUiThread(() -> Toast.makeText(this, "Ya tenés la última versión", Toast.LENGTH_SHORT).show());
                }
            } catch (Exception e) {
                if (manual) runOnUiThread(() ->
                    Toast.makeText(this, "No se pudo verificar: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void promptInstall(String versionName, String apkUrl) {
        new AlertDialog.Builder(this)
            .setTitle("Actualización disponible")
            .setMessage("Hay una versión nueva (" + versionName + "). ¿Descargar e instalar?")
            .setPositiveButton("Actualizar", (d, w) -> downloadAndInstall(apkUrl))
            .setNegativeButton("Ahora no", null)
            .show();
    }

    private void downloadAndInstall(String apkUrl) {
        downloadAndInstall(apkUrl, "update.apk", "Descargando actualización…");
    }

    /** Descarga un APK a la caché y lanza el instalador (actualización o build). */
    private void downloadAndInstall(String apkUrl, String fileName, String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                File apk = new File(getExternalCacheDir(), fileName);
                HttpURLConnection c = (HttpURLConnection) new URL(apkUrl).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                }
                c.disconnect();
                runOnUiThread(() -> install(apk));
            } catch (Exception e) {
                runOnUiThread(() ->
                    Toast.makeText(this, "Error al descargar: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void install(File apk) {
        // Android 8+ exige permiso explícito para instalar desde esta app.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Permití \"Instalar apps desconocidas\" y reintentá", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())));
            return;
        }
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(i);
    }

    // --- Puente JS ↔ nativo (links + portapapeles) -------------------------

    /** Expuesto al WebView como `window.CRNative`. */
    private class NativeBridge {
        /** Abre una URL en el navegador/app del sistema. */
        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No se pudo abrir el link", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** Descarga e instala un APK (build detectado en la PC). */
        @JavascriptInterface
        public void installApk(String url, String name) {
            if (url == null || url.isEmpty()) return;
            String safe = (name == null || name.isEmpty()) ? "build.apk" : name.replaceAll("[^\\w.\\-]", "_");
            if (!safe.toLowerCase().endsWith(".apk")) safe += ".apk";
            final String file = safe;
            runOnUiThread(() -> downloadAndInstall(url, file, "Descargando " + file + "…"));
        }

        /** Copia texto al portapapeles del sistema. */
        @JavascriptInterface
        public void copy(String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Claude", text));
            });
        }

        /** Lee el portapapeles (en el hilo de UI) y lo devuelve por window.__crPaste. */
        @JavascriptInterface
        public void requestPaste() {
            runOnUiThread(() -> {
                String text = "";
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                    if (t != null) text = t.toString();
                }
                if (web != null) {
                    web.evaluateJavascript(
                        "window.__crPaste && window.__crPaste(" + JSONObject.quote(text) + ");", null);
                }
            });
        }
    }

    private String httpGet(String urlStr) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        try (InputStream in = c.getInputStream()) {
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, "UTF-8"));
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }
}
