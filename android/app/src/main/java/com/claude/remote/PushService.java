package com.claude.remote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/** Recibe las notificaciones push de Claude Remote y registra el token FCM. */
public class PushService extends FirebaseMessagingService {

    static final String CHANNEL = "claude";

    @Override
    public void onNewToken(String token) {
        sendTokenToServer(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        // En primer plano el sistema no muestra la notificación solo: la armamos.
        String title = "Claude";
        String body = "";
        if (msg.getNotification() != null) {
            if (msg.getNotification().getTitle() != null) title = msg.getNotification().getTitle();
            if (msg.getNotification().getBody() != null) body = msg.getNotification().getBody();
        } else {
            title = msg.getData().getOrDefault("title", title);
            body = msg.getData().getOrDefault("body", body);
        }
        showNotification(title, body, msg.getData().get("path"));
    }

    private void showNotification(String title, String body, String path) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                new NotificationChannel(CHANNEL, "Avisos de Claude", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) open.putExtra("path", path); // al tocar, abre ese proyecto
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi);
        nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), b.build());
    }

    /** Manda el token FCM al servidor configurado en la app (POST /api/push/register). */
    static void sendTokenToServer(Context ctx, String token) {
        SharedPreferences prefs = ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE);
        String base = prefs.getString("url", "");
        if (base == null || base.isEmpty() || token == null) return;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        final String url = base + "/api/push/register";
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] payload = new JSONObject().put("token", token).toString().getBytes("UTF-8");
                c.getOutputStream().write(payload);
                c.getInputStream().close();
                c.disconnect();
            } catch (Exception ignored) {
                /* si el servidor no está, se reintenta al reabrir la app */
            }
        }).start();
    }
}
