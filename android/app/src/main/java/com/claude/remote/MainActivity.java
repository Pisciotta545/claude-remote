package com.claude.remote;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Menu;
import android.view.MenuItem;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        String url = prefs.getString("url", null);
        if (url == null) showConfig();
        else showWeb(url);
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
        web.setWebViewClient(new WebViewClient());
        web.loadUrl(url);
        checkUpdate(false);   // chequeo silencioso al abrir
        ensureNotifications(); // permiso de notificaciones (Android 13+)
        registerPush();        // registra el token FCM en el servidor
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
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
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
        Toast.makeText(this, "Descargando actualización…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                File apk = new File(getExternalCacheDir(), "update.apk");
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
