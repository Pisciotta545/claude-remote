package com.claude.remote;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.provider.Settings;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.Menu;
import android.view.View;
import android.view.MenuItem;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;
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
    // Descargas de APK (actualización o build) con notificaciones.
    private static final String DL_PROGRESS = "descargas";
    private static final String DL_DONE = "descargas_listas";
    private static final String EXTRA_INSTALL = "installApk";
    private boolean resumed; // la app está en pantalla
    private AppLock lock;    // bloqueo con huella/PIN del celular

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        lock = new AppLock(this, prefs);
        if (getIntent() != null) pendingPath = getIntent().getStringExtra("path");
        TailnetManager.installCrashHandler(this);
        // Si la última vez se cerró, muestra el porqué. Si fue mientras arrancaba
        // Tailscale, abre la configuración en vez de reintentar (evita un bucle).
        boolean tsCrashed = TailnetManager.crashedLastTime(this) && TailnetManager.enabled(this);
        String report = TailnetManager.crashReport(this);
        String url = prefs.getString("url", null);
        if (url == null || tsCrashed) showConfig();
        else connect();
        // El detalle no se abre solo: queda en ⋮ → "Ver último cierre".
        if (report != null) Toast.makeText(this, "La app se cerró la última vez (detalle en ⋮)", Toast.LENGTH_SHORT).show();
        installFromExtra(getIntent());
    }

    /** Abre el servidor: directo (LAN / app Tailscale) o por el Tailscale integrado. */
    private void connect() {
        invalidateOptionsMenu(); // muestra/oculta las opciones de Tailscale
        if (TailnetManager.enabled(this)) showTailnet();
        else showWeb(prefs.getString("url", ""));
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        lock.onResume(); // pide huella/PIN al abrir o tras 1 min afuera
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
    }

    @Override
    protected void onStop() {
        super.onStop();
        lock.onStop();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getStringExtra("path") != null) {
            pendingPath = intent.getStringExtra("path");
            maybeOpenPending();
        }
        installFromExtra(intent);
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
        stopTailnetPolling();
        web = null;
        setContentView(R.layout.config);
        final EditText input = (EditText) findViewById(R.id.serverUrl);
        final CheckBox useTailnet = (CheckBox) findViewById(R.id.useTailnet);
        final EditText authKey = (EditText) findViewById(R.id.authKey);
        input.setText(prefs.getString("url", ""));
        useTailnet.setChecked(TailnetManager.enabled(this));
        authKey.setText(prefs.getString("authKey", ""));
        Button save = (Button) findViewById(R.id.saveBtn);
        save.setOnClickListener(v -> {
            String raw = input.getText().toString().trim();
            if (raw.isEmpty()) {
                Toast.makeText(this, "Ingresá una dirección", Toast.LENGTH_SHORT).show();
                return;
            }
            if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw = "http://" + raw;
            boolean wasTailnet = TailnetManager.enabled(this);
            prefs.edit()
                .putString("url", raw)
                .putBoolean("tailnet", useTailnet.isChecked())
                .putString("authKey", authKey.getText().toString().trim())
                .apply();
            // El destino del reenvío se fija al iniciar Tailscale: si ya corría,
            // hay que reiniciar la app para que tome la dirección nueva.
            if (wasTailnet && TailnetManager.running()) {
                Toast.makeText(this, "Reiniciando para aplicar la dirección…", Toast.LENGTH_SHORT).show();
                restartApp();
                return;
            }
            connect();
        });
    }

    private void restartApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(i);
        Runtime.getRuntime().exit(0);
    }

    // --- Tailscale integrado -------------------------------------------------

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Runnable tailnetPoll;
    private TextView tsStatus;
    private Button tsLogin;
    private String tsAuthUrl;
    private long tsLoginAskedAt;

    /** Pantalla "Conectando a Tailscale…": inicia el nodo y espera a que esté listo. */
    private void showTailnet() {
        web = null;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        box.setBackgroundColor(0xFF0F172A);

        TextView title = new TextView(this);
        title.setText("Tailscale integrado");
        title.setTextColor(0xFFE2E8F0);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        tsStatus = new TextView(this);
        tsStatus.setText("Iniciando…");
        tsStatus.setTextColor(0xFF94A3B8);
        tsStatus.setTextSize(15);
        tsStatus.setGravity(Gravity.CENTER);
        tsStatus.setPadding(0, dp(12), 0, dp(20));
        box.addView(tsStatus);

        tsLogin = new Button(this);
        tsLogin.setText("Iniciar sesión en Tailscale");
        tsLogin.setVisibility(View.GONE);
        tsLogin.setOnClickListener(v -> {
            if (tsAuthUrl != null) openExternal(tsAuthUrl);
        });
        box.addView(tsLogin);

        Button logsBtn = new Button(this);
        logsBtn.setText("Ver registro");
        logsBtn.setOnClickListener(v -> showTailnetInfo());
        box.addView(logsBtn);

        Button cfg = new Button(this);
        cfg.setText("Cambiar servidor");
        cfg.setOnClickListener(v -> showConfig());
        box.addView(cfg);

        setContentView(box);

        new Thread(() -> {
            try {
                TailnetManager.start(this);
            } catch (Throwable t) {
                TailnetManager.markHealthy(this); // falló con error, no se cerró la app
                ui.post(() -> tsStatus.setText("No se pudo iniciar Tailscale:\n" + t.getMessage()));
                return;
            }
            ui.post(this::startTailnetPolling);
            // Si sigue viva 30 s después de arrancar, no hubo cierre al iniciar.
            ui.postDelayed(() -> TailnetManager.markHealthy(this), 30000);
        }).start();
    }

    private void startTailnetPolling() {
        stopTailnetPolling();
        tailnetPoll = new Runnable() {
            @Override
            public void run() {
                if (tailnetPoll != this) return;
                new Thread(() -> {
                    JSONObject st = TailnetManager.status();
                    ui.post(() -> onTailnetStatus(st));
                }).start();
                ui.postDelayed(this, 1000);
            }
        };
        ui.post(tailnetPoll);
    }

    private void stopTailnetPolling() {
        if (tailnetPoll != null) ui.removeCallbacks(tailnetPoll);
        tailnetPoll = null;
    }

    private void onTailnetStatus(JSONObject st) {
        if (tailnetPoll == null || tsStatus == null) return; // ya se salió de la pantalla
        String state = st.optString("state");
        tsAuthUrl = st.optString("authURL", "");
        if (tsAuthUrl.isEmpty()) tsAuthUrl = null;
        tsLogin.setVisibility(View.GONE);
        switch (state) {
            case "Running":
                stopTailnetPolling();
                showWeb(TailnetManager.localBase());
                return;
            case "NeedsLogin":
                if (tsAuthUrl != null) {
                    tsStatus.setText("Iniciá sesión con tu cuenta de Tailscale (la misma de la PC). Después volvé a la app.");
                    tsLogin.setVisibility(View.VISIBLE);
                } else {
                    tsStatus.setText("Pidiendo link de inicio de sesión…");
                    long now = System.currentTimeMillis();
                    if (now - tsLoginAskedAt > 15000) {
                        tsLoginAskedAt = now;
                        new Thread(() -> { try { TailnetManager.login(); } catch (Throwable ignored) {} }).start();
                    }
                }
                return;
            case "NeedsMachineAuth":
                tsStatus.setText("Aprobá este dispositivo en la consola de Tailscale (login.tailscale.com/admin/machines).");
                return;
            default:
                String err = st.optString("error", "");
                tsStatus.setText("Conectando a tu red Tailscale…" + (err.isEmpty() ? "" : "\n" + err));
        }
    }

    /** Estado y registro de Tailscale (diagnóstico), con opción de copiar. */
    private void showTailnetInfo() {
        JSONObject st = TailnetManager.status();
        String info = "Estado: " + st.optString("state") +
            "\nNombre: " + st.optString("name", "—") +
            "\nIP: " + st.optString("ip", "—") +
            "\nServidor: " + prefs.getString("url", "") +
            "\n\n" + TailnetManager.logs();
        showTextDialog("Tailscale", info);
    }

    /** Diálogo con texto largo seleccionable y botón "Copiar" (reportes, registro). */
    private void showTextDialog(String title, String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextIsSelectable(true);
        tv.setTextSize(11);
        tv.setPadding(dp(16), dp(8), dp(16), dp(8));
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setView(sv)
            .setPositiveButton("Copiar", (d, w) -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText(title, text));
                Toast.makeText(this, "Copiado", Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("Cerrar", null)
            .show();
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Toast.makeText(this, "No se pudo abrir el navegador", Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Con Tailscale integrado, la cookie del reenvío local debe estar antes de cargar. */
    private void showWeb(String url) {
        if (TailnetManager.enabled(this) && TailnetManager.running()) {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setCookie(url, TailnetManager.cookie() + "; path=/", ok -> {
                cm.flush();
                loadWeb(url);
            });
        } else {
            loadWeb(url);
        }
    }

    /**
     * WebView que pide al teclado el modo "sin sugerencias" (como Termux). Con
     * sugerencias, Gboard y otros componen la palabra y al tocar un signo (?, !, ,)
     * la reenvían entera: xterm.js la recibe otra vez y el texto sale duplicado.
     */
    static class TerminalWebView extends WebView {
        TerminalWebView(Context c) { super(c); }

        @Override
        public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            InputConnection ic = super.onCreateInputConnection(outAttrs);
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT
                    | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            return ic;
        }
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void loadWeb(String url) {
        web = new TerminalWebView(this);
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
        lock.onActivityResult(requestCode, resultCode);
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
        if (TailnetManager.enabled(this)) {
            menu.add(0, 3, 0, "Tailscale: estado y registro");
            menu.add(0, 4, 0, "Tailscale: cerrar sesión");
        }
        menu.add(0, 5, 0, lock.enabled() ? "Bloqueo con huella/PIN: activado" : "Bloqueo con huella/PIN: desactivado");
        menu.add(0, 6, 0, "Ver último cierre");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (lock.isLocked()) return true; // nada del menú sin desbloquear
        if (item.getItemId() == 5) {
            lock.setEnabled(!lock.enabled());
            invalidateOptionsMenu();
            return true;
        }
        if (item.getItemId() == 6) {
            String r = TailnetManager.lastReport(this);
            if (r == null) Toast.makeText(this, "No hubo cierres", Toast.LENGTH_SHORT).show();
            else showTextDialog("Último cierre", r);
            return true;
        }
        if (item.getItemId() == 1) {
            showConfig();
            return true;
        }
        if (item.getItemId() == 3) {
            showTailnetInfo();
            return true;
        }
        if (item.getItemId() == 4) {
            new Thread(() -> {
                try { TailnetManager.logout(); } catch (Throwable ignored) {}
                runOnUiThread(this::showTailnet); // muestra el botón de login de nuevo
            }).start();
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
        if (lock.isLocked()) {
            moveTaskToBack(true); // bloqueada: atrás solo la manda al fondo
            return;
        }
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
        // Con Tailscale integrado todo pasa por el reenvío local.
        if (TailnetManager.enabled(this)) return TailnetManager.running() ? TailnetManager.localBase() : "";
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
        downloadAndInstall(apkUrl, "update.apk", "Actualización de Claude Remote");
    }

    /**
     * Descarga un APK a la caché (actualización o build) mostrando notificaciones
     * de inicio, progreso y fin. Tocar la de fin abre el instalador; si la app está
     * en pantalla, el instalador se abre solo.
     */
    private void downloadAndInstall(String apkUrl, String fileName, String title) {
        Toast.makeText(this, "Descargando " + title + "…", Toast.LENGTH_SHORT).show();
        final int id = 1000 + (fileName.hashCode() & 0xffff);
        final NotificationManager nm = downloadChannels();
        new Thread(() -> {
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, DL_PROGRESS)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText("Iniciando descarga…")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(0, 0, true);
            nm.notify(id, b.build());
            try {
                File apk = new File(getExternalCacheDir(), fileName);
                HttpURLConnection c = TailnetManager.open(this, apkUrl);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                long total = c.getContentLengthLong(), done = 0, lastAt = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        done += n;
                        long now = SystemClock.uptimeMillis();
                        if (now - lastAt < 400) continue; // no saturar el sistema de notificaciones
                        lastAt = now;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            b.setProgress(100, pct, false).setContentText(pct + "% · " + mb(done) + " de " + mb(total));
                        } else {
                            b.setContentText(mb(done) + " descargados");
                        }
                        nm.notify(id, b.build());
                    }
                }
                c.disconnect();
                nm.notify(id, new NotificationCompat.Builder(this, DL_DONE)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("Descarga completa · " + title)
                    .setContentText("Tocá para instalar (" + mb(apk.length()) + ")")
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(installIntent(apk, id))
                    .build());
                runOnUiThread(() -> { if (resumed) install(apk); });
            } catch (Exception e) {
                nm.notify(id, new NotificationCompat.Builder(this, DL_DONE)
                    .setSmallIcon(android.R.drawable.stat_notify_error)
                    .setContentTitle("Error al descargar · " + title)
                    .setContentText(String.valueOf(e.getMessage()))
                    .setAutoCancel(true)
                    .build());
                runOnUiThread(() ->
                    Toast.makeText(this, "Error al descargar: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private static String mb(long bytes) {
        return String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0);
    }

    /** Canales: progreso (silencioso) y fin de descarga (con aviso). */
    private NotificationManager downloadChannels() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                new NotificationChannel(DL_PROGRESS, "Progreso de descargas", NotificationManager.IMPORTANCE_LOW));
            nm.createNotificationChannel(
                new NotificationChannel(DL_DONE, "Descargas completas", NotificationManager.IMPORTANCE_HIGH));
        }
        return nm;
    }

    /**
     * Qué abre la notificación de fin: el instalador directo si ya hay permiso para
     * instalar; si no, la app (que pide el permiso y después instala).
     */
    private PendingIntent installIntent(File apk, int requestCode) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls()) {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return PendingIntent.getActivity(this, requestCode, i, flags);
        }
        Intent open = new Intent(this, MainActivity.class)
            .putExtra(EXTRA_INSTALL, apk.getName())
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, requestCode, open, flags);
    }

    /** Instala un APK ya descargado en la caché (desde la notificación de fin). */
    private void installFromExtra(Intent intent) {
        String name = intent == null ? null : intent.getStringExtra(EXTRA_INSTALL);
        if (name == null) return;
        intent.removeExtra(EXTRA_INSTALL);
        File apk = new File(getExternalCacheDir(), new File(name).getName()); // solo archivos de la caché
        if (apk.exists()) install(apk);
        else Toast.makeText(this, "El archivo ya no está, volvé a descargarlo", Toast.LENGTH_LONG).show();
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
            runOnUiThread(() -> downloadAndInstall(url, file, file));
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
        HttpURLConnection c = TailnetManager.open(this, urlStr);
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
