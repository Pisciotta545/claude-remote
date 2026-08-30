package com.claude.remote;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

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
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Cambiar servidor");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            showConfig();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
