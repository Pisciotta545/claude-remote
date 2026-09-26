package com.claude.remote;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Bloqueo de la app con la huella, el rostro o el PIN/patrón del celular: la
 * terminal no tiene contraseña, así que quien tenga el celular desbloqueado no
 * debe poder entrar. Pide al abrir y al volver tras {@link #TIMEOUT_MS} afuera.
 * Mientras está bloqueada, una capa tapa todo (la WebView sigue viva debajo).
 */
final class AppLock {
    static final int REQ_UNLOCK = 300;
    private static final long TIMEOUT_MS = 60_000;
    private static final String KEY = "appLock";

    private final Activity act;
    private final SharedPreferences prefs;
    private boolean locked = true;       // arranca bloqueada
    private boolean authenticating;      // el diálogo de huella/PIN está abierto
    private long backgroundAt;           // cuándo salió a segundo plano (0 = no salió)
    private View overlay;

    AppLock(Activity act, SharedPreferences prefs) {
        this.act = act;
        this.prefs = prefs;
        // Sin vista previa de la terminal en "recientes" (Android 13+).
        if (enabled() && Build.VERSION.SDK_INT >= 33) act.setRecentsScreenshotEnabled(false);
    }

    boolean enabled() {
        return prefs.getBoolean(KEY, true);
    }

    boolean isLocked() {
        return enabled() && locked;
    }

    void setEnabled(boolean on) {
        prefs.edit().putBoolean(KEY, on).apply();
        if (Build.VERSION.SDK_INT >= 33) act.setRecentsScreenshotEnabled(!on);
        if (!on) unlock();
        Toast.makeText(act, on ? "Bloqueo activado" : "Bloqueo desactivado", Toast.LENGTH_SHORT).show();
    }

    /** Llamar en onResume: bloquea si corresponde y pide la huella/PIN. */
    void onResume() {
        if (!enabled()) return;
        if (backgroundAt > 0 && SystemClock.elapsedRealtime() - backgroundAt > TIMEOUT_MS) locked = true;
        backgroundAt = 0;
        if (locked) {
            showOverlay();
            authenticate();
        }
    }

    /** Llamar en onStop: empieza a contar el tiempo afuera (salvo el propio diálogo de PIN). */
    void onStop() {
        if (!authenticating && !locked) backgroundAt = SystemClock.elapsedRealtime();
    }

    /** Resultado de la pantalla de PIN/patrón (Android 7–9). */
    void onActivityResult(int requestCode, int resultCode) {
        if (requestCode != REQ_UNLOCK) return;
        authenticating = false;
        if (resultCode == Activity.RESULT_OK) unlock();
    }

    private void authenticate() {
        if (authenticating) return;
        KeyguardManager km = (KeyguardManager) act.getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) {
            // Sin bloqueo de pantalla no hay con qué verificar: no se puede proteger.
            unlock();
            Toast.makeText(act, "Configurá un bloqueo de pantalla en el celular para proteger la app",
                Toast.LENGTH_LONG).show();
            return;
        }
        authenticating = true;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                biometricPrompt();
                return;
            } catch (Throwable t) {
                // Si la huella falla (permiso, fabricante…), no cerrar la app: usar el PIN.
            }
        }
        confirmCredential(km);
    }

    /** Diálogo del sistema: huella/rostro con opción de PIN (Android 10+). */
    private void biometricPrompt() {
        if (Build.VERSION.SDK_INT >= 29) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(act)
                .setTitle("Desbloquear Claude Remote")
                .setSubtitle("Usá tu huella, rostro o PIN");
            if (Build.VERSION.SDK_INT >= 30) {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK
                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                //noinspection deprecation
                b.setDeviceCredentialAllowed(true);
            }
            b.build().authenticate(new CancellationSignal(), act.getMainExecutor(),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                        authenticating = false;
                        unlock();
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence msg) {
                        authenticating = false; // cancelado: queda bloqueada, se reintenta con el botón
                    }
                });
        }
    }

    /** Pantalla de PIN/patrón del sistema (Android 7–9, o si la huella falló). */
    private void confirmCredential(KeyguardManager km) {
        //noinspection deprecation
        Intent i = km.createConfirmDeviceCredentialIntent("Desbloquear Claude Remote", "Ingresá tu PIN o patrón");
        if (i == null) {
            authenticating = false;
            unlock();
            return;
        }
        try {
            act.startActivityForResult(i, REQ_UNLOCK);
        } catch (Exception e) {
            authenticating = false;
            unlock(); // sin forma de verificar: mejor abrir que dejar la app inutilizable
            Toast.makeText(act, "No se pudo pedir el PIN: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void unlock() {
        locked = false;
        if (overlay != null) {
            ((ViewGroup) overlay.getParent()).removeView(overlay);
            overlay = null;
        }
    }

    /** Capa opaca sobre toda la ventana (por encima de cualquier setContentView). */
    private void showOverlay() {
        if (overlay != null) return;
        float d = act.getResources().getDisplayMetrics().density;
        LinearLayout box = new LinearLayout(act);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(0xFF0F172A);
        box.setClickable(true); // no deja tocar lo de abajo

        TextView icon = new TextView(act);
        icon.setText("🔒");
        icon.setTextSize(48);
        icon.setGravity(Gravity.CENTER);
        box.addView(icon);

        TextView title = new TextView(act);
        title.setText("Claude Remote bloqueado");
        title.setTextColor(0xFFE2E8F0);
        title.setTextSize(18);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, (int) (12 * d), 0, (int) (24 * d));
        box.addView(title);

        Button btn = new Button(act);
        btn.setText("Desbloquear");
        btn.setOnClickListener(v -> authenticate());
        box.addView(btn);

        ((ViewGroup) act.getWindow().getDecorView()).addView(box,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay = box;
    }
}
