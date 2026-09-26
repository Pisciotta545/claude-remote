package com.claude.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.os.Build;

import com.claude.remote.go.tailnet.Tailnet;

import org.json.JSONObject;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Locale;

/**
 * Tailscale integrado (tsnet en Go, ver android/tailnet): la app entra a la
 * tailnet por sí misma, sin VPN ni la app de Tailscale, y abre un reenvío local
 * 127.0.0.1:puerto → servidor de la PC. El reenvío exige la cookie {@code cr_ts}
 * con un secreto por proceso, así otras apps del celular no pueden usarlo.
 */
final class TailnetManager {
    private static final int PREFERRED_PORT = 38080;
    private static volatile int port = 0;
    private static String secret;
    private static boolean callbackRegistered;

    private TailnetManager() {}

    static boolean enabled(Context ctx) {
        return prefs(ctx).getBoolean("tailnet", false);
    }

    static boolean running() {
        return port > 0;
    }

    /** Base HTTP del reenvío local (válida después de {@link #start}). */
    static String localBase() {
        return "http://127.0.0.1:" + port;
    }

    static synchronized String cookie() {
        if (secret == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            secret = sb.toString();
        }
        return Tailnet.CookieName + "=" + secret;
    }

    /** Levanta el nodo (idempotente). Bloquea unos segundos: llamar fuera del hilo de UI. */
    static synchronized void start(Context ctx) throws Exception {
        SharedPreferences p = prefs(ctx);
        File dir = dir(ctx);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        // Marca "arrancando": si la app se cierra antes de markHealthy(), al
        // reabrir se muestra el reporte y no se reintenta solo (evita un bucle).
        p.edit().putBoolean(KEY_STARTING, true).commit();
        Tailnet.init(dir.getAbsolutePath()); // primero: deja crash.txt y tailnet.log
        pushInterfaces();
        registerNetworkCallback(ctx.getApplicationContext());
        String sec = cookie().substring(Tailnet.CookieName.length() + 1);
        port = (int) Tailnet.start(dir.getAbsolutePath(), hostname(), p.getString("authKey", ""),
            target(p.getString("url", "")), sec, PREFERRED_PORT);
    }

    /** Estado de Tailscale: {state, authURL, ip, name, error}. */
    static JSONObject status() {
        try {
            return new JSONObject(Tailnet.status());
        } catch (Throwable t) {
            JSONObject o = new JSONObject();
            try { o.put("state", "Stopped").put("error", String.valueOf(t.getMessage())); } catch (Exception ignored) {}
            return o;
        }
    }

    static void login() throws Exception { Tailnet.login(); }

    static void logout() throws Exception { Tailnet.logout(); }

    static String logs() {
        try { return Tailnet.logs(); } catch (Throwable t) { return String.valueOf(t); }
    }

    /**
     * Abre una conexión HTTP al servidor. Manda la clave de la app (el servidor
     * rechaza lo que no la traiga) y, con Tailscale integrado, la cookie del
     * reenvío local (las URLs ya apuntan a 127.0.0.1).
     */
    static HttpURLConnection open(Context ctx, String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        String key = prefs(ctx).getString(APP_KEY, null);
        if (key != null) c.setRequestProperty("X-CR-Key", key);
        if (enabled(ctx) && url.startsWith("http://127.0.0.1:")) c.setRequestProperty("Cookie", cookie());
        return c;
    }

    /** Preferencia con la clave que da el servidor al vincular (POST /api/pair). */
    static final String APP_KEY = "appKey";

    // --- Diagnóstico de cierres ---------------------------------------------

    private static final String KEY_STARTING = "tsStarting";
    private static final String GO_CRASH = "crash.txt";
    private static final String JAVA_CRASH = "crash-java.txt";
    private static final String LOG = "tailnet.log";
    private static final String LAST_REPORT = "last-crash.txt";

    static File dir(Context ctx) {
        return new File(ctx.getFilesDir(), "tailscale");
    }

    /** Tailscale arrancó y la app siguió viva: ya no hace falta la marca. */
    static void markHealthy(Context ctx) {
        prefs(ctx).edit().remove(KEY_STARTING).apply();
    }

    /** Guarda en disco cualquier excepción Java no atrapada antes de que se cierre la app. */
    static void installCrashHandler(Context ctx) {
        final File out = new File(dir(ctx), JAVA_CRASH);
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        if (prev instanceof CrashHandler) return;
        Thread.setDefaultUncaughtExceptionHandler(new CrashHandler(out, prev));
    }

    private static final class CrashHandler implements Thread.UncaughtExceptionHandler {
        private final File out;
        private final Thread.UncaughtExceptionHandler prev;

        CrashHandler(File out, Thread.UncaughtExceptionHandler prev) {
            this.out = out;
            this.prev = prev;
        }

        @Override
        public void uncaughtException(Thread t, Throwable e) {
            try {
                //noinspection ResultOfMethodCallIgnored
                out.getParentFile().mkdirs();
                java.io.StringWriter sw = new java.io.StringWriter();
                e.printStackTrace(new java.io.PrintWriter(sw));
                try (java.io.FileOutputStream f = new java.io.FileOutputStream(out)) {
                    f.write(("Hilo: " + t.getName() + "\n" + sw).getBytes("UTF-8"));
                }
            } catch (Throwable ignored) {
                /* nada más que hacer */
            }
            if (prev != null) prev.uncaughtException(t, e);
        }
    }

    /** true si la última vez la app se cerró mientras Tailscale arrancaba. */
    static boolean crashedLastTime(Context ctx) {
        return prefs(ctx).getBoolean(KEY_STARTING, false);
    }

    /**
     * Arma el reporte del último cierre (errores de Go y Java + registro de
     * Tailscale + datos del equipo), o null si no hubo cierre. Lo consume:
     * borra los archivos de error y la marca, para no mostrarlo dos veces.
     */
    static String crashReport(Context ctx) {
        File d = dir(ctx);
        String go = readTail(new File(d, GO_CRASH), 200);
        String java = readTail(new File(d, JAVA_CRASH), 200);
        boolean starting = crashedLastTime(ctx);
        if (go.isEmpty() && java.isEmpty() && !starting) return null;
        //noinspection ResultOfMethodCallIgnored
        new File(d, GO_CRASH).delete();
        //noinspection ResultOfMethodCallIgnored
        new File(d, JAVA_CRASH).delete();
        markHealthy(ctx);
        StringBuilder sb = new StringBuilder();
        sb.append("Claude Remote ").append(BuildConfig.VERSION_NAME)
            .append(" · Android ").append(Build.VERSION.RELEASE).append(" (SDK ").append(Build.VERSION.SDK_INT).append(')')
            .append(" · ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" · ").append(String.join(",", Build.SUPPORTED_ABIS)).append('\n');
        if (go.isEmpty() && java.isEmpty()) {
            sb.append("\n(Sin mensaje de error: se cerró en código nativo o el sistema cerró la app.)\n");
        }
        if (!go.isEmpty()) sb.append("\n== Error de Go ==\n").append(go).append('\n');
        if (!java.isEmpty()) sb.append("\n== Error de Java ==\n").append(java).append('\n');
        sb.append("\n== Registro de Tailscale (últimas líneas) ==\n").append(readTail(new File(d, LOG), 80));
        String report = sb.toString();
        // Queda guardado para verlo cuando se pida (menú ⋮ → Ver último cierre).
        try (java.io.FileOutputStream f = new java.io.FileOutputStream(new File(d, LAST_REPORT))) {
            f.write(report.getBytes("UTF-8"));
        } catch (Exception ignored) {
            /* sin disco: solo se pierde el reporte */
        }
        return report;
    }

    /** Último reporte de cierre guardado, o null si no hay. */
    static String lastReport(Context ctx) {
        String r = readTail(new File(dir(ctx), LAST_REPORT), 1000);
        return r.isEmpty() ? null : r;
    }


    /** Últimas {@code maxLines} líneas de un archivo de texto ("" si no existe). */
    private static String readTail(File f, int maxLines) {
        if (!f.isFile() || f.length() == 0) return "";
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) bo.write(buf, 0, n);
            String[] lines = bo.toString("UTF-8").split("\n");
            int from = Math.max(0, lines.length - maxLines);
            return String.join("\n", java.util.Arrays.copyOfRange(lines, from, lines.length)).trim();
        } catch (Exception e) {
            return "(no se pudo leer " + f.getName() + ": " + e.getMessage() + ")";
        }
    }

    // --- Internos -----------------------------------------------------------

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE);
    }

    /** "http://mi-pc:3000" → "mi-pc:3000" (puerto 80 si no tiene). */
    private static String target(String url) {
        Uri u = Uri.parse(url);
        String host = u.getHost() == null ? url : u.getHost();
        int p = u.getPort() > 0 ? u.getPort() : 80;
        return host + ":" + p;
    }

    /** Nombre del dispositivo en la tailnet, p. ej. "claude-remote-sm-s918b". */
    private static String hostname() {
        String model = Build.MODEL == null ? "android" : Build.MODEL.toLowerCase(Locale.ROOT);
        return ("claude-remote-" + model.replaceAll("[^a-z0-9]+", "-")).replaceAll("-+$", "");
    }

    /**
     * Android 11+ no deja a Go listar interfaces por netlink: se las pasamos desde
     * Java. Formato por línea: "nombre índice mtu up broadcast loopback p2p multicast | ip/prefijo ...".
     */
    private static void pushInterfaces() {
        StringBuilder sb = new StringBuilder();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                boolean broadcast = false;
                StringBuilder addrs = new StringBuilder();
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) broadcast = true;
                    String ip = ia.getAddress().getHostAddress();
                    int pct = ip.indexOf('%');
                    if (pct >= 0) ip = ip.substring(0, pct); // quita el "%wlan0" de IPv6
                    addrs.append(' ').append(ip).append('/').append(ia.getNetworkPrefixLength());
                }
                sb.append(ni.getName()).append(' ').append(ni.getIndex()).append(' ').append(ni.getMTU())
                    .append(' ').append(ni.isUp()).append(' ').append(broadcast)
                    .append(' ').append(ni.isLoopback()).append(' ').append(ni.isPointToPoint())
                    .append(' ').append(ni.supportsMulticast()).append(" |").append(addrs).append('\n');
            }
        } catch (Exception ignored) {
            /* sin interfaces: tsnet reintenta con lo que haya */
        }
        Tailnet.setInterfaces(sb.toString());
    }

    /** Avisa a Go cada cambio de red (Wi-Fi ↔ datos) para reconectar al instante. */
    private static void registerNetworkCallback(Context app) {
        if (callbackRegistered) return;
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override
            public void onLinkPropertiesChanged(Network network, LinkProperties lp) {
                changed(lp.getInterfaceName());
            }

            @Override
            public void onLost(Network network) {
                changed("");
            }

            private void changed(String iface) {
                try {
                    pushInterfaces();
                    Tailnet.networkChanged(iface == null ? "" : iface);
                } catch (Throwable ignored) {
                    /* librería no cargada */
                }
            }
        });
        callbackRegistered = true;
    }
}
