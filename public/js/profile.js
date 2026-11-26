// Profile: each user edits their own display name and photo (upload, Google photo, or initials).
// The database only lets an account change its own profile (profile_* functions).
import { html, useState, Icon, Avatar, initials, toast, forgetPhoto, bus } from './lib.js';
import { rpc } from './teamwork.js';

// Square, centre-cropped JPEG of at most 256 px, so uploads stay small (a few dozen KB).
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is too large (15 MB at most).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('That file couldn’t be read as an image.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(256, side);
    const c = document.createElement('canvas');
    c.width = c.height = out;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, out, out);
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    let q = 0.86, data = c.toDataURL('image/jpeg', q);
    while (data.length > 380000 && q > 0.4) { q -= 0.12; data = c.toDataURL('image/jpeg', q); }
    return data;
  } finally { URL.revokeObjectURL(url); }
}

export function Profile() {
  const d = window.__dash;
  const [p, setP] = useState(d.profile);
  const [name, setName] = useState((d.profile && d.profile.display_name) || '');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  if (!p) return html`<div><header class="page-head"><h1>Profile</h1></header><p class="muted">Profiles need cloud sync.</p></div>`;
  const google = d.user && d.user.picture;
  const apply = (next, msg) => {
    forgetPhoto(next.id);
    d.profile = next; setP(next); setPreview(null);
    window.dispatchEvent(new CustomEvent('dash-profile'));
    bus.emit(false);
    if (msg) toast({ msg });
  };
  const run = (fn, msg) => async () => {
    setBusy(true);
    try { apply(await fn(), msg); } catch (e) { toast({ msg: e.message, kind: 'error' }); setPreview(null); } finally { setBusy(false); }
  };
  const saveName = (e) => { e.preventDefault(); run(() => rpc('profile_set_name', { p_display_name: name.trim() || null }), 'Display name saved')(); };
  const upload = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try { data = await shrink(f); } catch (err) { return toast({ msg: err.message, kind: 'error' }); }
    setPreview(data);
    run(() => rpc('profile_set_photo', { p_data: data }), 'Photo updated')();
  };
  const shownName = name.trim() || p.sign_in_name || p.email || '';
  const dirty = name.trim() !== (p.display_name || '');
  return html`<div>
    <header class="page-head"><h1>Profile</h1><span class="muted">How you appear to your teammates.</span></header>
    <div class="card profile-card">
      <div class="profile-photo">
        <${Avatar} p=${{ ...p, name: shownName }} size=${96} src=${preview} />
        <div class="stack" style="gap:8px">
          <div class="row wrap">
            <label class="btn sm primary" style="cursor:pointer"><${Icon} name="plus" size=${14} />Upload photo
              <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled=${busy} onChange=${upload} /></label>
            ${google && p.photo_kind !== 'google' && html`<button class="btn sm" disabled=${busy} onClick=${run(() => rpc('profile_use_google_photo', { p_url: google }), 'Using your Google photo')}>Use my Google photo</button>`}
            ${p.photo_kind && html`<button class="btn sm danger" disabled=${busy} onClick=${run(() => rpc('profile_remove_photo', {}), 'Photo removed')}>Remove photo</button>`}
          </div>
          <span class="small muted">${p.photo_kind === 'google' ? 'Showing your Google photo.' : p.photo_kind === 'upload' ? 'Showing your uploaded photo.' : `No photo: your initials (${initials(shownName)}) are shown.`}
            Teammates and Super Admins see it.</span>
        </div>
      </div>
      <form class="stack" onSubmit=${saveName}>
        <label class="field">Display name
          <input type="text" maxlength="80" value=${name} placeholder=${p.sign_in_name || 'Your name'} onInput=${(e) => setName(e.target.value)} />
          <span class="hint">Shown in teams, on tasks and to Super Admins. Leave empty to use the name from your sign-in${p.sign_in_name ? ` (${p.sign_in_name})` : ''}.</span></label>
        <div class="row"><span class="small muted">Email: ${p.email || '—'}${p.email && !p.email_verified ? ' (not confirmed)' : ''}</span><span class="spacer"></span>
          <button class="btn primary" disabled=${busy || !dirty}>Save name</button></div>
      </form>
    </div>
  </div>`;
}
