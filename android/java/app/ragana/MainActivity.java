package app.ragana;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Обёртка WebView вокруг веб-слоя ragana.
 *
 * ГЛАВНОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ — ВИРТУАЛЬНЫЙ ORIGIN.
 * Ассеты НЕЛЬЗЯ отдавать через file://: такой документ получает opaque
 * origin, из-за чего НЕ РАБОТАЕТ IndexedDB и не загружаются модульные
 * воркеры. А IndexedDB — единственное хранилище, общее для WebView,
 * расширения и браузера, то есть то, ради чего затевалась общая кодовая
 * база. Поэтому всё обслуживается с https://ragana.localhost через
 * shouldInterceptRequest.
 *
 * Заголовки COOP/COEP выставляются там же: без них нет SharedArrayBuffer,
 * а без него onnxruntime-web не может в многопоточный WASM и откатывается
 * на один поток.
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://ragana.localhost";
    private static final int REQ_PICK_TREE = 1001;

    private WebView web;
    private Uri pickedTree;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        // Системное масштабирование шрифта не должно ломать вёрстку чипов
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri url = req.getUrl();
                if (!(url.getScheme() + "://" + url.getHost()).equals(ORIGIN)) {
                    return null; // внешние запросы (CDN модели) идут как есть
                }
                String path = url.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                return serveAsset(path.substring(1));
            }
        });

        web.addJavascriptInterface(new Bridge(), "Native");
        web.loadUrl(ORIGIN + "/index.html");
        setContentView(web);
    }

    /** Отдаёт файл из assets с правильным типом и заголовками изоляции. */
    private WebResourceResponse serveAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            Map<String, String> headers = new HashMap<>();
            // Нужны для SharedArrayBuffer => многопоточного WASM
            headers.put("Cross-Origin-Opener-Policy", "same-origin");
            headers.put("Cross-Origin-Embedder-Policy", "require-corp");
            headers.put("Cross-Origin-Resource-Policy", "cross-origin");
            headers.put("Cache-Control", "no-cache");

            WebResourceResponse r = new WebResourceResponse(mimeOf(name), "UTF-8", in);
            r.setResponseHeaders(headers);
            return r;
        } catch (IOException e) {
            return new WebResourceResponse(
                "text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(),
                new ByteArrayInputStream(("нет файла: " + name).getBytes()));
        }
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".wasm")) return "application/wasm";
        if (name.endsWith(".onnx")) return "application/octet-stream";
        return "application/octet-stream";
    }

    /**
     * Мост к тому, чего веб не умеет на Android.
     *
     * File System Access API в WebView отсутствует, поэтому выбор папки
     * идёт через системный SAF, а чтение файлов — через ContentResolver.
     */
    private class Bridge {

        @JavascriptInterface
        public void pickFolder() {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                     | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(i, REQ_PICK_TREE);
        }

        /** Список файлов выбранного дерева: [{path,size,mtime,uri}, ...] */
        @JavascriptInterface
        public String listFiles() {
            if (pickedTree == null) return "[]";
            JSONArray out = new JSONArray();
            try {
                String docId = DocumentsContract.getTreeDocumentId(pickedTree);
                walk(pickedTree, docId, "", out);
            } catch (Exception e) {
                return "[]";
            }
            return out.toString();
        }

        /** Содержимое файла в base64 — JS-мост не умеет бинарь. */
        @JavascriptInterface
        public String readFile(String uriStr) {
            try (InputStream in = getContentResolver().openInputStream(Uri.parse(uriStr))) {
                if (in == null) return "";
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return android.util.Base64.encodeToString(bos.toByteArray(),
                        android.util.Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String deviceInfo() {
            try {
                JSONObject o = new JSONObject();
                o.put("model", Build.MODEL);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("platform", "android");
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }
    }

    private void walk(Uri tree, String docId, String prefix, JSONArray out) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        try (android.database.Cursor c = getContentResolver().query(children, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        }, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.getLong(3);
                long mtime = c.getLong(4);
                String path = prefix.isEmpty() ? name : prefix + "/" + name;

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (name.startsWith(".")) continue;
                    walk(tree, id, path, out);
                } else {
                    JSONObject o = new JSONObject();
                    o.put("path", path);
                    o.put("size", size);
                    o.put("mtime", mtime);
                    o.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                    out.put(o);
                }
            }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK_TREE && res == RESULT_OK && data != null && data.getData() != null) {
            pickedTree = data.getData();
            getContentResolver().takePersistableUriPermission(pickedTree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
            web.evaluateJavascript("window.__onFolderPicked && window.__onFolderPicked()", null);
        }
    }

    @Override
    public void onBackPressed() {
        // Back отдаётся в JS; finish() только если там нечего закрывать
        web.evaluateJavascript("window.__onBack ? window.__onBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }
}
