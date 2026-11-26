package com.freerouter.webproxy;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListAdapter;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;
import com.freerouter.webproxy.Health;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/* loaded from: classes.dex */
public class ServersActivity extends Activity {
    private RowAdapter adapter;
    private final List<String[]> layers = new ArrayList();
    private final List<String> states = new ArrayList();
    private final List<Integer> mss = new ArrayList();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean testing = false;

    @Override // android.app.Activity
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        setContentView(R.layout.activity_servers);
        for (String[] strArr : Prefs.layers(this)) {
            this.layers.add(strArr);
            int lastMs = Prefs.lastMs(this, strArr[1]);
            this.states.add("idle");
            this.mss.add(Integer.valueOf(lastMs));
        }
        this.adapter = new RowAdapter(this, null);
        ListView listView = (ListView) findViewById(R.id.list);
        listView.setAdapter((ListAdapter) this.adapter);
        listView.setOnItemClickListener(new ServersActivity$$ExternalSyntheticLambda0(this));
        listView.setOnItemLongClickListener(new ServersActivity$$ExternalSyntheticLambda1(this));
        ((Button) findViewById(R.id.btn_test_all)).setOnClickListener(new ServersActivity$$ExternalSyntheticLambda2(this));
        ((Button) findViewById(R.id.btn_add)).setOnClickListener(new ServersActivity$$ExternalSyntheticLambda3(this));
        findViewById(R.id.btn_guide).setOnClickListener(new ServersActivity$$ExternalSyntheticLambda4(this));
        findViewById(R.id.btn_done).setOnClickListener(new ServersActivity$$ExternalSyntheticLambda5(this));
        listView.postDelayed(new ServersActivity$$ExternalSyntheticLambda6(this), 250L);
    }

    /* renamed from: lambda$onCreate$0$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m17lambda$onCreate$0$comfreerouterwebproxyServersActivity(AdapterView adapterView, View view, int i, long j) {
        activate(i);
    }

    /* renamed from: lambda$onCreate$1$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ boolean m18lambda$onCreate$1$comfreerouterwebproxyServersActivity(AdapterView adapterView, View view, int i, long j) {
        rowMenu(i);
        return true;
    }

    /* renamed from: lambda$onCreate$2$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m19lambda$onCreate$2$comfreerouterwebproxyServersActivity(View view) {
        testAll();
    }

    /* renamed from: lambda$onCreate$3$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m20lambda$onCreate$3$comfreerouterwebproxyServersActivity(View view) {
        addDialog();
    }

    /* renamed from: lambda$onCreate$4$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m21lambda$onCreate$4$comfreerouterwebproxyServersActivity(View view) {
        guide();
    }

    /* renamed from: lambda$onCreate$5$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m22lambda$onCreate$5$comfreerouterwebproxyServersActivity(View view) {
        finish();
    }

    /* renamed from: lambda$onCreate$6$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m23lambda$onCreate$6$comfreerouterwebproxyServersActivity() {
        if (this.testing) {
            return;
        }
        testAll();
    }

    @Override // android.app.Activity
    protected void onDestroy() {
        super.onDestroy();
        persist();
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void persist() {
        Prefs.setLayers(this, this.layers, Prefs.active(this));
    }

    private void activate(int i) {
        if (i < 0 || i >= this.layers.size()) {
            return;
        }
        Prefs.setActive(this, i);
        persist();
        this.adapter.notifyDataSetChanged();
        toast(getString(R.string.layer_active_now, new Object[]{this.layers.get(i)[0]}));
        setResult(-1);
        finish();
    }

    private void rowMenu(int i) {
        new AlertDialog.Builder(this).setTitle(this.layers.get(i)[0]).setItems(new String[]{getString(R.string.test_this), getString(R.string.rename), getString(R.string.make_active), getString(R.string.delete)}, new ServersActivity$$ExternalSyntheticLambda10(this, i)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
    }

    /* renamed from: lambda$rowMenu$7$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m25lambda$rowMenu$7$comfreerouterwebproxyServersActivity(int i, DialogInterface dialogInterface, int i2) {
        if (i2 == 0) {
            testOne(i);
            return;
        }
        if (i2 == 1) {
            renameDialog(i);
        } else if (i2 == 2) {
            activate(i);
        } else {
            deleteDialog(i);
        }
    }

    private void deleteDialog(int i) {
        if (this.layers.size() <= 1) {
            toast(getString(R.string.cant_delete_last));
        } else {
            new AlertDialog.Builder(this).setMessage(getString(R.string.delete_confirm, new Object[]{this.layers.get(i)[0]})).setPositiveButton(R.string.delete, new ServersActivity$$ExternalSyntheticLambda7(this, i)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
        }
    }

    /* renamed from: lambda$deleteDialog$8$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m16lambda$deleteDialog$8$comfreerouterwebproxyServersActivity(int i, DialogInterface dialogInterface, int i2) {
        int active = Prefs.active(this);
        this.layers.remove(i);
        this.states.remove(i);
        this.mss.remove(i);
        if (active >= i) {
            active = Math.max(0, active - (active > i ? 1 : 0));
        }
        Prefs.setActive(this, active);
        persist();
        this.adapter.notifyDataSetChanged();
    }

    private void addDialog() {
        LinearLayout linearLayout = new LinearLayout(this);
        linearLayout.setOrientation(1);
        int i = (int) (getResources().getDisplayMetrics().density * 16.0f);
        linearLayout.setPadding(i, i / 2, i, 0);
        EditText editText = new EditText(this);
        editText.setHint(getString(R.string.layer_name_hint));
        editText.setTextDirection(4);
        linearLayout.addView(editText);
        EditText editText2 = new EditText(this);
        editText2.setHint(getString(R.string.layer_url_hint));
        editText2.setInputType(16);
        editText2.setTextDirection(3);
        linearLayout.addView(editText2);
        new AlertDialog.Builder(this).setTitle(R.string.add_layer).setView(linearLayout).setPositiveButton(R.string.add, new ServersActivity$$ExternalSyntheticLambda8(this, editText, editText2)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
    }

    /* renamed from: lambda$addDialog$9$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m15lambda$addDialog$9$comfreerouterwebproxyServersActivity(EditText editText, EditText editText2, DialogInterface dialogInterface, int i) {
        String trim = editText.getText().toString().trim();
        String replaceAll = editText2.getText().toString().trim().replaceAll("/+$", "");
        if (trim.isEmpty() || (!replaceAll.startsWith("https://") && !replaceAll.startsWith("http://"))) {
            toast(getString(R.string.invalid_layer));
            return;
        }
        Iterator<String[]> it = this.layers.iterator();
        while (it.hasNext()) {
            if (it.next()[1].equals(replaceAll)) {
                toast(getString(R.string.layer_exists));
                return;
            }
        }
        this.layers.add(new String[]{trim, replaceAll});
        this.states.add("idle");
        this.mss.add(-1);
        persist();
        this.adapter.notifyDataSetChanged();
        testOne(this.layers.size() - 1);
    }

    private void renameDialog(int i) {
        EditText editText = new EditText(this);
        editText.setText(this.layers.get(i)[0]);
        int i2 = (int) (getResources().getDisplayMetrics().density * 16.0f);
        FrameLayout frameLayout = new FrameLayout(this);
        frameLayout.setPadding(i2, i2 / 2, i2, 0);
        frameLayout.addView(editText);
        new AlertDialog.Builder(this).setTitle(R.string.rename).setView(frameLayout).setPositiveButton(R.string.ok, new ServersActivity$$ExternalSyntheticLambda9(this, editText, i)).setNegativeButton(R.string.cancel, (DialogInterface.OnClickListener) null).show();
    }

    /* renamed from: lambda$renameDialog$10$com-freerouter-webproxy-ServersActivity, reason: not valid java name */
    /* synthetic */ void m24lambda$renameDialog$10$comfreerouterwebproxyServersActivity(EditText editText, int i, DialogInterface dialogInterface, int i2) {
        String trim = editText.getText().toString().trim();
        if (trim.isEmpty()) {
            return;
        }
        this.layers.get(i)[0] = trim;
        persist();
        this.adapter.notifyDataSetChanged();
    }

    private void testAll() {
        if (this.testing || this.layers.isEmpty()) {
            return;
        }
        this.testing = true;
        for (int i = 0; i < this.layers.size(); i++) {
            this.states.set(i, "test");
            this.mss.set(i, -1);
        }
        this.adapter.notifyDataSetChanged();
        ArrayList arrayList = new ArrayList();
        Iterator<String[]> it = this.layers.iterator();
        while (it.hasNext()) {
            arrayList.add(it.next()[1]);
        }
        Health.testAll(arrayList, this.ui, listener());
    }

    private void testOne(int i) {
        if (this.testing) {
            return;
        }
        this.testing = true;
        this.states.set(i, "test");
        this.mss.set(i, -1);
        this.adapter.notifyDataSetChanged();
        ArrayList arrayList = new ArrayList();
        arrayList.add(this.layers.get(i)[1]);
        Health.testAll(arrayList, this.ui, new AnonymousClass1(i));
    }

    /* renamed from: com.freerouter.webproxy.ServersActivity$1, reason: invalid class name */
    class AnonymousClass1 implements Health.Listener {
        final /* synthetic */ int val$pos;

        @Override // com.freerouter.webproxy.Health.Listener
        public void onFirstAwake(int i, int i2) {
        }

        AnonymousClass1(int i) {
            this.val$pos = i;
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onLayer(int i, String str, int i2, int i3) {
            ServersActivity.this.states.set(this.val$pos, str);
            ServersActivity.this.mss.set(this.val$pos, Integer.valueOf(i2));
            ServersActivity.this.adapter.notifyDataSetChanged();
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onAllDone(int i, int i2) {
            ServersActivity.this.testing = false;
        }
    }

    /* renamed from: com.freerouter.webproxy.ServersActivity$2, reason: invalid class name */
    class AnonymousClass2 implements Health.Listener {
        @Override // com.freerouter.webproxy.Health.Listener
        public void onFirstAwake(int i, int i2) {
        }

        AnonymousClass2() {
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onLayer(int i, String str, int i2, int i3) {
            if (i < ServersActivity.this.states.size()) {
                ServersActivity.this.states.set(i, str);
                ServersActivity.this.mss.set(i, Integer.valueOf(i2));
                ServersActivity.this.adapter.notifyDataSetChanged();
            }
        }

        @Override // com.freerouter.webproxy.Health.Listener
        public void onAllDone(int i, int i2) {
            ServersActivity.this.testing = false;
            if (i < 0) {
                ServersActivity serversActivity = ServersActivity.this;
                serversActivity.toast(serversActivity.getString(R.string.all_layers_down));
            } else {
                if (i == Prefs.active(ServersActivity.this) || ServersActivity.this.layers.size() <= 1) {
                    return;
                }
                AlertDialog.Builder builder = new AlertDialog.Builder(ServersActivity.this);
                ServersActivity serversActivity2 = ServersActivity.this;
                builder.setMessage(serversActivity2.getString(R.string.fastest_is, new Object[]{((String[]) serversActivity2.layers.get(i))[0], String.valueOf(i2)})).setPositiveButton(R.string.yes, new ServersActivity$2$$ExternalSyntheticLambda0(this, i)).setNegativeButton(R.string.no, (DialogInterface.OnClickListener) null).show();
            }
        }

        /* renamed from: lambda$onAllDone$0$com-freerouter-webproxy-ServersActivity$2, reason: not valid java name */
        /* synthetic */ void m26lambda$onAllDone$0$comfreerouterwebproxyServersActivity$2(int i, DialogInterface dialogInterface, int i2) {
            Prefs.setActive(ServersActivity.this, i);
            ServersActivity.this.persist();
            ServersActivity.this.adapter.notifyDataSetChanged();
            ServersActivity.this.setResult(-1);
        }
    }

    private Health.Listener listener() {
        return new AnonymousClass2();
    }

    private void guide() {
        new AlertDialog.Builder(this).setTitle(R.string.guide_title).setMessage(getString(R.string.guide_body)).setPositiveButton(R.string.ok, (DialogInterface.OnClickListener) null).show();
    }

    private class RowAdapter extends BaseAdapter {
        @Override // android.widget.Adapter
        public long getItemId(int i) {
            return i;
        }

        private RowAdapter() {
        }

        /* synthetic */ RowAdapter(ServersActivity serversActivity, AnonymousClass1 anonymousClass1) {
            this();
        }

        @Override // android.widget.Adapter
        public int getCount() {
            return ServersActivity.this.layers.size();
        }

        @Override // android.widget.Adapter
        public Object getItem(int i) {
            return ServersActivity.this.layers.get(i);
        }

        @Override // android.widget.Adapter
        public View getView(int i, View view, ViewGroup viewGroup) {
            String[] strArr;
            int intValue;
            String string;
            int i2;
            String string2;
            if (view == null) {
                view = ServersActivity.this.getLayoutInflater().inflate(R.layout.item_server, viewGroup, false);
            }
            TextView textView = (TextView) view.findViewById(R.id.r_name);
            TextView textView2 = (TextView) view.findViewById(R.id.r_url);
            TextView textView3 = (TextView) view.findViewById(R.id.r_state);
            View findViewById = view.findViewById(R.id.r_dot);
            TextView textView4 = (TextView) view.findViewById(R.id.r_active);
            strArr = (String[]) ServersActivity.this.layers.get(i);
            textView.setText(strArr[0]);
            textView2.setText(strArr[1]);
            String str = i < ServersActivity.this.states.size() ? (String) ServersActivity.this.states.get(i) : "idle";
            intValue = i < ServersActivity.this.mss.size() ? ((Integer) ServersActivity.this.mss.get(i)).intValue() : -1;
            str.hashCode();
            switch (str) {
                case "ok":
                    string = ServersActivity.this.getString(R.string.st_ready, new Object[]{String.valueOf(intValue)});
                    i2 = -13315175;
                    break;
                case "dead":
                    string = ServersActivity.this.getString(R.string.st_dead);
                    i2 = -495247;
                    break;
                case "test":
                    string2 = ServersActivity.this.getString(R.string.st_testing);
                    string = string2;
                    i2 = -278748;
                    break;
                case "wake":
                    string2 = ServersActivity.this.getString(R.string.st_waking);
                    string = string2;
                    i2 = -278748;
                    break;
                default:
                    int lastMs = Prefs.lastMs(ServersActivity.this, strArr[1]);
                    i2 = -10193781;
                    if (lastMs > 0) {
                        string = ServersActivity.this.getString(R.string.st_last_seen, new Object[]{String.valueOf(lastMs)});
                        break;
                    } else {
                        string = ServersActivity.this.getString(R.string.st_idle);
                        break;
                    }
            }
            textView3.setText(string);
            textView3.setTextColor(i2);
            GradientDrawable gradientDrawable = new GradientDrawable();
            gradientDrawable.setShape(1);
            gradientDrawable.setColor(i2);
            findViewById.setBackground(gradientDrawable);
            boolean z = i == Prefs.active(ServersActivity.this);
            textView4.setVisibility(z ? 0 : 4);
            view.setBackgroundColor(z ? 371381230 : 0);
            return view;
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
