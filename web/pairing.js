(function(){
  const toastContainer = document.getElementById('toast-container');
  const tvNameInput = document.getElementById('tv-name');
  const backBtn = document.getElementById('back-btn');
  const statusPill = document.getElementById('pair-status');
  const pinInput = document.getElementById('pin-input');
  const submitBtn = document.getElementById('submit-pin');
  const pinCard = document.getElementById('pin-card');
  const pairedCard = document.getElementById('paired-card');
  const forceUnpairBtn = document.getElementById('force-unpair-btn');

  function escapeHtml(str){
    return String(str)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#39;');
  }

  function showToast(kind, title, message){
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
    toastContainer.appendChild(toast);
    const ttl = kind === 'error' ? 7000 : 4500;
    setTimeout(()=>{ toast.style.opacity='0'; toast.style.transition='opacity 0.25s ease'; setTimeout(()=>toast.remove(),260); }, ttl);
  }

  function getTvFromQuery(){
    const u = new URL(window.location.href);
    return u.searchParams.get('tv') || '';
  }

  const tv = getTvFromQuery();
  tvNameInput.value = tv || '(missing tv)';

  backBtn.addEventListener('click', ()=>{
    if (tv) window.location.href = `/?tv=${encodeURIComponent(tv)}`;
    else window.location.href = '/';
  });

  async function refreshStatus(){
    if (!tv){
      statusPill.textContent = 'Missing tv parameter';
      pinCard.classList.add('hidden');
      return;
    }
    try{
      const r = await fetch(`/api/pairing-status?tv=${encodeURIComponent(tv)}`);
      const data = await r.json();
      if (!data.success) throw new Error(data.message || 'status failed');

      if (data.paired && !data.pinRequired){
        statusPill.textContent = 'Paired ✅';
        pairedCard.classList.remove('hidden');
        pinCard.classList.add('hidden');
      } else {
        statusPill.textContent = 'PIN required';
        pairedCard.classList.add('hidden');
        pinCard.classList.remove('hidden');
      }
    }catch(e){
      statusPill.textContent = 'Status error';
      showToast('error','Error','Unable to read pairing status');
    }
  }

  async function loadDeviceInfo(){
    try {
      const r = await fetch(`/api/device-info?tv=${encodeURIComponent(tv)}`);
      const data = await r.json();
      if (!data.success || !data.data) return;
      const d = data.data;
      const statusEl = document.getElementById('device-info-status');
      const modelEl = document.getElementById('di-model');
      const serialEl = document.getElementById('di-serial');
      const firmwareEl = document.getElementById('di-firmware');
      const interfaceEl = document.getElementById('di-interface');
      const apisEl = document.getElementById('di-apis');
      const detectedEl = document.getElementById('di-detected-at');

      // Interface info (always available — no auth)
      if (d.interface) {
        modelEl.textContent = (d.interface.productName || '') + ' ' + (d.interface.modelName || '') || '—';
        interfaceEl.textContent = d.interface.interfaceVersion || '—';
      }
      // System info (available after pairing)
      if (d.system) {
        if (d.system.model) modelEl.textContent = d.system.model;
        serialEl.textContent = d.system.serial || '—';
        firmwareEl.textContent = (d.system.generation || '—');
      } else {
        serialEl.textContent = 'Available after pairing';
        firmwareEl.textContent = 'Available after pairing';
      }
      // API versions
      if (d.apiVersions && Object.keys(d.apiVersions).length > 0) {
        apisEl.textContent = Object.entries(d.apiVersions).map(([k,v]) => k + ': v' + v).join(' | ');
      }
      // Detected at
      if (d.detectedAt) {
        detectedEl.textContent = 'Last detected: ' + new Date(d.detectedAt).toLocaleString();
      }
      if (statusEl) statusEl.textContent = d.interface ? '✅ Info loaded' : '⏳ Partial';
    } catch(e) {
      const statusEl = document.getElementById('device-info-status');
      if (statusEl) statusEl.textContent = 'Unavailable';
    }
  }

  async function submitPin(){
    const pin = (pinInput.value || '').trim();
    if (!pin){ showToast('warn','PIN missing','Enter the PIN shown on the TV'); return; }
    submitBtn.disabled = true;
    try{
      const r = await fetch(`/api/pin?tv=${encodeURIComponent(tv)}`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pin })
      });
      const data = await r.json();
      if (data.success){
        showToast('success','Sent','PIN sent, completing pairing…');
        pinInput.value = '';
        setTimeout(refreshStatus, 1000);
      } else {
        showToast('error','Rejected', data.message || 'PIN rejected');
      }
    }catch(e){
      showToast('error','Error','Network error while sending PIN');
    }finally{
      submitBtn.disabled = false;
    }
  }

  async function forceUnpair(){
    if (!confirm('Delete the stored cookie and force re-pairing?\nThe TV will show a new PIN.')) return;
    forceUnpairBtn.disabled = true;
    try{
      const r = await fetch(`/api/delete-cookie?tv=${encodeURIComponent(tv)}`,{
        method:'POST'
      });
      const data = await r.json();
      if (data.success){
        showToast('success','Cookie deleted','Re-pairing required. Turn on the TV to get a new PIN.');
        setTimeout(refreshStatus, 800);
      } else {
        showToast('error','Error', data.message || 'Could not delete cookie');
      }
    }catch(e){
      showToast('error','Error','Network error while deleting cookie');
    }finally{
      forceUnpairBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submitPin);
  pinInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') submitPin(); });
  forceUnpairBtn.addEventListener('click', forceUnpair);

  refreshStatus();
  loadDeviceInfo();
})();
