// Daily Workspace — exposes ONLY the name of the focused app on the session bus, for the local
// PC Work Time agent (Activity Details). No window titles, contents or input are read.
//   gdbus call --session --dest org.gnome.Shell --object-path /com/dailyworkspace/FocusedApp \
//     --method com.dailyworkspace.FocusedApp.Get
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node><interface name="com.dailyworkspace.FocusedApp">
  <method name="Get"><arg type="s" direction="out" name="app"/></method>
</interface></node>`;

export default class FocusedAppExtension extends Extension {
    enable() {
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Get() {
                const app = Shell.WindowTracker.get_default().focus_app;
                return app ? app.get_name() : '';
            },
        });
        this._impl.export(Gio.DBus.session, '/com/dailyworkspace/FocusedApp');
    }

    disable() {
        this._impl?.unexport();
        this._impl = null;
    }
}
