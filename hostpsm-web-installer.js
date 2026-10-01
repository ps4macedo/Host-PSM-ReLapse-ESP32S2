// Host PSM 1.1.0 — revisão do instalador 2026-09-12. ROM ESP32-S2, sem stub.
// Os testes locais modelam o protocolo; a aprovação na placa é independente.
const INSTALLER_REVISION = "2026-09-12-r1";
const ROM = Object.freeze({flashBegin: 0x02, flashData: 0x03, sync: 0x08,
  writeReg: 0x09, readReg: 0x0a, spiSetParams: 0x0b, spiAttach: 0x0d, flashMd5: 0x13});
const FLASH_BYTES = 0x400000;
const FLASH_BLOCK_SIZE = 0x400;
const FLASH_SECTOR_SIZE = 0x1000;
const INITIAL_BAUD = 115200;
const LIMITS = Object.freeze({open: 10000, command: 4000, sync: 3000,
  data: 8000, cleanup: 5000, download: 60000, manifest: 15000});
const LAYOUT = Object.freeze([
  {path: "firmware/bootloader.bin", offset: 0x1000, max: 0x7000},
  {path: "firmware/partitions.bin", offset: 0x8000, max: 0x1000},
  {path: "firmware/boot_app0.bin", offset: 0xe000, max: 0x2000, exact: 0x2000},
  {path: "firmware/HostPSM_ESP32S2.bin", offset: 0x10000, max: 0x3f0000},
]);
const alignUp = (value, alignment) => Math.ceil(value / alignment) * alignment;
const hex = (value) => `0x${value.toString(16)}`;
const errorText = (error) => error?.message || String(error);
function fault(message, code = "PROTOCOL") {
  return Object.assign(new Error(message), {code});
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
}
function u32Packet(values) {
  const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return out;
}
function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
function flashChecksum(bytes) {
  let checksum = 0xef;
  for (const byte of bytes) checksum ^= byte;
  return checksum;
}
function makePacket(command, payload, checksum = 0) {
  const out = new Uint8Array(8 + payload.length), view = new DataView(out.buffer);
  out[1] = command;
  view.setUint16(2, payload.length, true);
  view.setUint32(4, checksum, true);
  out.set(payload, 8);
  return out;
}
function slipEncode(packet) {
  const out = [0xc0];
  for (const b of packet) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(0xc0);
  return new Uint8Array(out);
}
function parseResponse(frame) {
  if (!frame || frame.length < 12 || frame[0] !== 1) throw fault("Resposta ROM inválida (direção/cabeçalho).");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const size = view.getUint16(2, true);
  if (size < 4 || frame.length !== 8 + size) throw fault("Resposta ROM truncada ou com tamanho inválido.");
  const status = frame[frame.length - 4], code = frame[frame.length - 3];
  if (status !== 0) throw fault(`ROM recusou ${hex(frame[1])} (status ${status}, erro ${code}).`, "ROM_ERROR");
  return {command: frame[1], value: view.getUint32(4, true), data: frame.slice(8, -4)};
}

// O prazo engloba a operação inteira. A promise original continua observada.
// Abort/timeout serial não é apresentado como cancelamento da chamada nativa.
function bounded(promise, ms, label, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); fn(value); };
    const abort = () => finish(reject, signal.reason || fault("Operação interrompida.", "CANCELLED"));
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, {once: true});
    timer = setTimeout(() => finish(reject, fault(`Tempo esgotado: ${label}.`, "TIMEOUT")), ms);
  });
}

class SlipFrameReader {
  constructor(reader, onFailure = () => {}) {
    this.reader = reader;
    this.onFailure = onFailure;
    this.frames = [];
    this.waiter = null;
    this.current = [];
    this.inFrame = false;
    this.escaped = false;
    this.terminal = null;
    this.finished = false;
    this.releaseError = null;
    this.pumpPromise = this.pump();
  }
  fail(error) {
    if (this.terminal) return;
    this.terminal = error;
    this.frames.length = 0;
    this.current.length = 0;
    this.inFrame = this.escaped = false;
    if (this.waiter) { this.waiter.reject(error); this.waiter = null; }
  }
  async pump() {
    let batchBytes = 0;
    try {
      while (!this.terminal) {
        const {value, done} = await this.reader.read();
        if (this.terminal) break;
        if (done) throw fault("A leitura serial foi encerrada pela placa.", "DISCONNECTED");
        if (value) {
          this.feed(value);
          batchBytes += value.length;
          // Cede o event loop sob tráfego contínuo, sem temporizar o protocolo.
          if (batchBytes >= 4096) {
            batchBytes = 0;
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }
    } catch (error) {
      this.fail(error);
      this.onFailure(error);
    } finally {
      try { this.reader.releaseLock(); }
      catch (error) { this.releaseError = error; this.onFailure(error); }
      this.finished = true;
    }
  }
  feed(chunk) {
    if (this.terminal) return;
    for (const byte of chunk) {
      if (byte === 0xc0) {
        if (this.escaped) throw fault("Escape SLIP incompleto.");
        if (this.current.length) {
          const response = parseResponse(new Uint8Array(this.current));
          this.current.length = 0;
          if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(response); }
          else {
            // SYNC pode produzir oito respostas. Nenhum comando usado retorna
            // mais que 32 bytes de dados + 4 de status + 8 de cabeçalho.
            if (this.frames.length >= 16) throw fault("Excesso de respostas seriais; conexão encerrada.");
            this.frames.push(response);
          }
        }
        this.inFrame = true;
      } else if (this.inFrame) {
        if (this.escaped) {
          if (byte !== 0xdc && byte !== 0xdd) throw fault("Escape SLIP inválido.");
          this.current.push(byte === 0xdc ? 0xc0 : 0xdb);
          this.escaped = false;
        } else if (byte === 0xdb) this.escaped = true;
        else this.current.push(byte);
        if (this.current.length > 44) throw fault("Resposta serial excede o limite do protocolo ROM.");
      }
    }
  }
  nextResponse() {
    if (this.terminal) return Promise.reject(this.terminal);
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.waiter) return Promise.reject(fault("Leituras concorrentes bloqueadas."));
    return new Promise((resolve, reject) => { this.waiter = {resolve, reject}; });
  }
  async waitFor(command) {
    for (;;) {
      const response = await this.nextResponse();
      if (response.command === command) return response;
      if (response.command !== ROM.sync) throw fault(`Resposta fora de sequência: ${hex(response.command)}; esperado ${hex(command)}.`);
      // Descarta apenas as respostas adicionais do SYNC já confirmado.
    }
  }
}

class HostPsmSerialFlasher {
  constructor(port, ui, {serial = globalThis.navigator?.serial, signal, limits = {}} = {}) {
    this.port = port;
    this.ui = ui;
    this.serial = serial;
    this.limits = {...LIMITS, ...limits};
    this.controller = new AbortController();
    this.state = "selected";
    this.opened = false;
    this.commandBusy = false;
    this.writePending = false;
    this.error = null;
    this.flashStarted = false;
    this.verified = false;
    this.onDisconnect = event => {
      if (event.target === this.port || event.port === this.port) this.fail(fault("ESP32-S2 desconectada.", "DISCONNECTED"));
    };
    this.onAbort = () => this.fail(signal.reason || fault("Instalação interrompida.", "CANCELLED"));
    this.externalSignal = signal;
    serial?.addEventListener("disconnect", this.onDisconnect);
    signal?.addEventListener("abort", this.onAbort, {once: true});
    if (signal?.aborted) this.onAbort();
  }
  fail(error) {
    if (!this.error) this.error = error;
    this.controller.abort(this.error);
    this.slip?.fail(this.error);
  }
  active() {
    if (this.error) throw this.error;
    if (["closing", "closed", "unreleased"].includes(this.state)) throw fault("A sessão serial já foi encerrada.");
  }
  async operation(promise, ms, label) {
    try { return await bounded(promise, ms, label, this.controller.signal); }
    catch (error) { this.fail(error); throw this.error; }
  }
  async openPort() {
    this.active();
    if (this.state !== "selected") throw fault("Abertura serial repetida bloqueada.");
    this.state = "opening";
    this.ui.phase("Abrindo conexão USB");
    const start = performance.now();
    this.ui.log(`port.open: início; ${INITIAL_BAUD} bps; nenhum controle de sinais solicitado.`);
    this.openPromise = Promise.resolve().then(() => {
      this.active();
      return this.port.open({baudRate: INITIAL_BAUD, bufferSize: 65536, flowControl: "none"});
    }).then(() => {
      this.opened = true;
      this.ui.log(`port.open: concluído em ${Math.round(performance.now() - start)} ms${this.error ? " (resposta tardia; somente limpeza)" : ""}.`);
    }, error => {
      this.ui.log(`port.open: falhou em ${Math.round(performance.now() - start)} ms: ${errorText(error)}`);
      throw error;
    });
    await this.operation(this.openPromise, this.limits.open, "abrir a porta USB");
    this.active();
    this.ui.log("Streams: início da criação do leitor e escritor.");
    if (!this.port.readable || !this.port.writable) throw fault("Porta aberta sem streams seriais disponíveis.");
    this.slip = new SlipFrameReader(this.port.readable.getReader(), error => this.fail(error));
    this.writer = this.port.writable.getWriter();
    this.state = "open";
    this.ui.log("Streams: leitor e escritor criados. DTR/RTS não foram alterados pelo instalador.");
  }
  async command(command, payload = new Uint8Array(), checksum = 0, ms = this.limits.command) {
    this.active();
    if (this.state !== "open" || this.commandBusy) throw fault("Comando fora de uma sessão livre e aberta.");
    this.commandBusy = true;
    const transaction = (async () => {
      this.writePending = true;
      this.writePromise = Promise.resolve().then(() => {
        this.active();
        return this.writer.write(slipEncode(makePacket(command, payload, checksum)));
      });
      try { await this.writePromise; }
      finally { this.writePending = false; }
      this.active();
      const response = await this.slip.waitFor(command);
      this.active();
      const expectedLength = command === ROM.flashMd5 ? 32 : 0;
      if (response.data.length !== expectedLength) throw fault(`Dados inesperados na resposta ${hex(command)}.`);
      return response;
    })();
    try { return await this.operation(transaction, ms, `comando ${hex(command)} (${this.ui.currentPhase || this.state})`); }
    finally { this.commandBusy = false; }
  }
  async sync() {
    this.ui.phase("Confirmando modo de gravação");
    const payload = new Uint8Array(36);
    payload.set([7, 7, 0x12, 0x20]); payload.fill(0x55, 4);
    try { await this.command(ROM.sync, payload, 0, this.limits.sync); }
    catch (error) {
      if (error.code === "TIMEOUT") error.message += " A porta não confirmou o modo de gravação. Desconecte a ESP, segure BOOT/B0 ao reconectar e solte o botão.";
      throw error;
    }
    this.ui.log("Bootloader ROM sincronizado; nenhum reset automático solicitado.");
  }
  async readReg(address) { return (await this.command(ROM.readReg, u32Packet([address]))).value; }
  async writeReg(address, value) { await this.command(ROM.writeReg, u32Packet([address, value, 0xffffffff, 0])); }
  async identify() {
    this.ui.phase("Conferindo ESP32-S2 e capacidade da flash");
    const magic = await this.readReg(0x40001000);
    if (magic !== 0x000007c6) throw fault(`Chip incompatível: identificação ${hex(magic)}. Nenhuma flash foi apagada.`);
    this.ui.log("Identificação ROM: ESP32-S2.");
    await this.command(ROM.spiAttach, u32Packet([0, 0]));
    const flashId = await this.readFlashId();
    const capacityCode = (flashId >>> 16) & 0xff;
    // Aceita somente identificações JEDEC com capacidade binária reconhecida.
    if ((flashId & 0xffff) === 0 || (flashId & 0xffff) === 0xffff || capacityCode < 18 || capacityCode > 26) {
      throw fault(`Capacidade da flash não reconhecida (${hex(flashId)}). Gravação bloqueada.`);
    }
    const capacity = 2 ** capacityCode;
    if (capacity < FLASH_BYTES) throw fault(`Flash insuficiente: ${capacity} bytes; projeto exige ${FLASH_BYTES}.`);
    this.ui.log(`Flash JEDEC ${hex(flashId)}: ${capacity} bytes; layout utilizado: ${FLASH_BYTES} bytes.`);
    await this.command(ROM.spiSetParams, u32Packet([0, FLASH_BYTES, 0x10000, FLASH_SECTOR_SIZE, 0x100, 0xffff]));
  }
  async readFlashId() {
    // SPI0 da ESP32-S2. RDID lê 24 bits; não apaga nem grava a flash.
    const base = 0x3f402000;
    const usr = base + 0x18, usr2 = base + 0x20;
    const mosi = base + 0x24, miso = base + 0x28, w0 = base + 0x58;
    const saved = [];
    for (const address of [usr, usr2, mosi, miso, w0]) saved.push([address, await this.readReg(address)]);
    await this.writeReg(usr, 0x90000000); // comando + MISO
    await this.writeReg(usr2, 0x7000009f); // 8 bits de comando RDID
    await this.writeReg(miso, 23);
    await this.writeReg(w0, 0);
    await this.writeReg(base, 0x40000); // SPI_USR
    let completed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (((await this.readReg(base)) & 0x40000) === 0) { completed = true; break; }
    }
    if (!completed) throw fault("A leitura da capacidade da flash não concluiu; reconecte a placa.");
    const id = (await this.readReg(w0)) & 0xffffff;
    // Não tenta restaurar registros depois de falha de transporte: sessão inválida.
    for (const [address, value] of saved) await this.writeReg(address, value);
    return id;
  }
  async flashPart(part, writtenBytes, totalBytes) {
    const eraseSize = alignUp(part.bytes.length, FLASH_SECTOR_SIZE);
    const blockCount = Math.ceil(part.bytes.length / FLASH_BLOCK_SIZE);
    this.ui.phase(`Preparando ${part.path.split("/").pop()}`);
    this.ui.log(`${part.path} @ ${hex(part.offset)}; ${part.bytes.length} bytes; apagamento ${eraseSize} bytes.`);
    this.flashStarted = true; // Antes de enviar: uma confirmação perdida não prova ausência de apagamento.
    await this.command(ROM.flashBegin, u32Packet([eraseSize, blockCount, FLASH_BLOCK_SIZE, part.offset, 0]), 0,
      Math.max(10000, Math.ceil(eraseSize / 0x100000) * 30000));
    this.ui.phase(`Gravando ${part.path.split("/").pop()}`);
    for (let sequence = 0; sequence < blockCount; sequence++) {
      this.active();
      const start = sequence * FLASH_BLOCK_SIZE, end = Math.min(start + FLASH_BLOCK_SIZE, part.bytes.length);
      const block = new Uint8Array(FLASH_BLOCK_SIZE).fill(0xff);
      block.set(part.bytes.subarray(start, end));
      await this.command(ROM.flashData, concatBytes([u32Packet([FLASH_BLOCK_SIZE, sequence, 0, 0]), block]), flashChecksum(block), this.limits.data);
      this.ui.progress((writtenBytes + end) / totalBytes, "Dados confirmados");
    }
  }
  async flash(parts) {
    // Todos os arquivos já devem estar validados com a porta fechada.
    await this.openPort();
    await this.sync();
    await this.identify();
    const total = parts.reduce((sum, p) => sum + p.bytes.length, 0);
    let written = 0;
    for (const part of parts) { await this.flashPart(part, written, total); written += part.bytes.length; }
    this.ui.phase("Verificando gravação na flash");
    this.ui.progress(null);
    for (const part of parts) {
      const response = await this.command(ROM.flashMd5, u32Packet([part.offset, part.bytes.length, 0, 0]), 0,
        Math.max(10000, Math.ceil(part.bytes.length / 0x100000) * 10000));
      const digest = new TextDecoder("ascii").decode(response.data).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(digest) || digest !== part.md5) throw fault(`Verificação da flash divergiu: ${part.path}. Não inicie o firmware; faça uma instalação completa.`);
      this.ui.log(`Flash verificada: ${part.path} (${part.bytes.length} bytes).`);
    }
    this.verified = true;
    this.ui.log("Quatro regiões gravadas e verificadas. Nenhum comando de reinício será enviado.");
  }
  async cleanup() {
    const errors = [];
    const capture = error => errors.push(errorText(error));
    // Se open resolver tardiamente, esta mesma tarefa fecha a porta; nunca cria streams.
    if (this.openPromise) await this.openPromise.catch(() => {}); // Falha de abertura já registrada.
    const readerTask = (async () => {
      if (!this.slip) return;
      let cancellation = Promise.resolve();
      if (!this.slip.finished) {
        try { cancellation = Promise.resolve(this.slip.reader.cancel()).catch(capture); }
        catch (error) { capture(error); }
      }
      await this.slip.pumpPromise;
      if (this.slip.releaseError) capture(this.slip.releaseError);
      await cancellation;
    })();
    const writerTask = (async () => {
      if (!this.writer) return;
      if (this.writePending) {
        let aborted;
        try { aborted = Promise.resolve(this.writer.abort(this.error)).catch(capture); }
        catch (error) { capture(error); }
        await this.writePromise.catch(() => {}); // Erro original pertence ao resultado da transação.
        await aborted;
      }
      try { this.writer.releaseLock(); } catch (error) { capture(error); }
    })();
    // Um cancelamento de leitura pendente não impede a liberação independente do escritor.
    await Promise.all([readerTask, writerTask]);
    if (this.opened) {
      if (this.port.readable?.locked || this.port.writable?.locked) throw fault("Streams ainda bloqueados; porta não liberada.", "CLEANUP");
      await this.port.close();
      this.opened = false;
    }
    this.state = "closed";
    this.serial?.removeEventListener("disconnect", this.onDisconnect);
    this.externalSignal?.removeEventListener("abort", this.onAbort);
    this.ui.log(`Conexão encerrada${errors.length ? "; ocorrências na limpeza: " + errors.join("; ") : "; recursos liberados"}.`);
    return {released: true, errors};
  }
  closePort() {
    if (this.closeResult) return this.closeResult;
    this.state = "closing";
    this.fail(fault("Sessão encerrada.", "CLOSED"));
    this.ui.phase("Encerrando conexão USB");
    this.ui.progress(null);
    this.cleanupPromise = this.cleanup();
    this.closeResult = bounded(this.cleanupPromise, this.limits.cleanup, "liberar a conexão USB").catch(error => {
      this.state = "unreleased";
      this.ui.log(`Liberação não confirmada: ${errorText(error)} A sessão não poderá ser reutilizada.`);
      return {released: false, errors: [errorText(error)]};
    });
    return this.closeResult;
  }
}

function validateManifest(manifest) {
  if (manifest?.new_install_prompt_erase !== false || manifest?.schema_version !== 2 ||
      !Array.isArray(manifest.builds) || manifest.builds.length !== 1 || manifest.builds[0].chipFamily !== "ESP32-S2") {
    throw fault("Manifesto incompatível. Gere novamente com GERAR_HOST_INSTALLER.bat.", "MANIFEST");
  }
  const parts = manifest.builds[0].parts;
  if (!Array.isArray(parts) || !parts.length) throw fault("Firmware ainda não gerado. Execute GERAR_HOST_INSTALLER.bat antes de publicar.", "MANIFEST");
  if (parts.length !== LAYOUT.length || manifest.flash_size !== FLASH_BYTES || !/^[0-9a-f]{64}$/.test(manifest.build_id)) {
    throw fault("Manifesto incompleto ou layout incompatível.", "MANIFEST");
  }
  for (let i = 0; i < LAYOUT.length; i++) {
    const part = parts[i], expected = LAYOUT[i];
    if (!part || part.path !== expected.path || part.offset !== expected.offset || !Number.isSafeInteger(part.size) ||
        part.size < 1 || part.size > expected.max || (expected.exact && part.size !== expected.exact) ||
        alignUp(part.size, FLASH_SECTOR_SIZE) > expected.max ||
        !/^[0-9a-f]{64}$/.test(part.sha256) || !/^[0-9a-f]{32}$/.test(part.md5)) {
      throw fault(`Componente inválido no manifesto: ${expected.path}.`, "MANIFEST");
    }
  }
  return {...manifest, parts: parts.map(p => ({...p}))};
}
async function fetchBytes(path, maxSize, signal, ms) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", relay, {once: true});
  if (signal?.aborted) relay();
  let reader;
  const task = (async () => {
    const response = await fetch(path, {cache: "no-store", signal: controller.signal, redirect: "error"});
    if (!response.ok) throw fault(`Arquivo não disponível: ${path} (HTTP ${response.status}).`, "DOWNLOAD");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxSize)) throw fault(`Tamanho HTTP inválido: ${path}.`, "DOWNLOAD");
    if (!response.body) throw fault(`Resposta vazia: ${path}.`, "DOWNLOAD");
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxSize) throw fault(`Download excede o tamanho permitido: ${path}.`, "DOWNLOAD");
        chunks.push(value);
      }
      return concatBytes(chunks);
    } finally { reader.releaseLock(); }
  })();
  try { return await bounded(task, ms, `baixar ${path}`, controller.signal); }
  finally {
    controller.abort(); // Interrompe efetivamente a rede em erro, timeout ou cancelamento.
    signal?.removeEventListener("abort", relay);
  }
}
async function loadManifest(signal) {
  const bytes = await fetchBytes("manifest.json", 32768, signal, LIMITS.manifest);
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (_) { throw fault("manifest.json não contém JSON válido.", "MANIFEST"); }
  return validateManifest(data);
}
function validateImages(parts) {
  for (const part of [parts[0], parts[3]]) {
    // Cabeçalho de imagem ESP: magic e chip_id do build precisam ser ESP32-S2.
    if (part.bytes.length < 24 || part.bytes[0] !== 0xe9 || new DataView(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength).getUint16(12, true) !== 2) {
      throw fault(`Imagem não identificada como ESP32-S2: ${part.path}.`, "IMAGE");
    }
  }
  const bytes = parts[1].bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expected = [["nvs", 1, 2, 0x9000, 0x5000], ["phy_init", 1, 1, 0xe000, 0x1000], ["app0", 0, 0, 0x10000, 0x3f0000]];
  const entries = [];
  for (let pos = 0; pos + 32 <= bytes.length && view.getUint16(pos, true) === 0x50aa; pos += 32) {
    const name = new TextDecoder().decode(bytes.slice(pos + 12, pos + 28)).split("\0")[0];
    entries.push([name, bytes[pos + 2], bytes[pos + 3], view.getUint32(pos + 4, true), view.getUint32(pos + 8, true)]);
  }
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw fault("Tabela de partições não corresponde ao layout aprovado.", "IMAGE");
}
async function loadFirmwareParts(ui, parts, signal) {
  const loaded = [];
  for (const part of parts) {
    ui.phase(`Conferindo ${part.path.split("/").pop()}`);
    const bytes = await fetchBytes(part.path, part.size, signal, LIMITS.download);
    if (bytes.length !== part.size) throw fault(`Tamanho divergente: ${part.path}.`, "DOWNLOAD");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    if (signal.aborted) throw signal.reason;
    if (sha256 !== part.sha256) throw fault(`SHA-256 divergente: ${part.path}. Gere/publique o build completo.`, "DOWNLOAD");
    loaded.push({...part, bytes});
    ui.log(`Download conferido: ${part.path}; ${bytes.length} bytes; SHA-256 ${sha256}.`);
  }
  validateImages(loaded);
  ui.log("Quatro arquivos conferidos antes de abrir a porta. Layout preserva 0x9000–0xDFFF (NVS).");
  return loaded;
}

const LOG_KEY = "hostpsm-web-installer-diagnostic";
class InstallerUi {
  // Somente apresentação: mensagens técnicas permanecem integrais no registro.
  static showView(view, previous = false) {
    const modal = document.getElementById("hostpsmModal");
    if (modal) modal.dataset.view = view;
    const icon = document.getElementById("modalStateIcon");
    if (icon) icon.setAttribute("href", view === "error" ? "#alertIcon" : "#chipIcon");
    const support = document.getElementById("modalSupport");
    if (support) support.open = false;
    const label = document.getElementById("modalSupportLabel");
    if (label) label.textContent = view === "connect" ? "Ajuda" : "Detalhes";
    const previousButton = document.getElementById("previousLog");
    if (previousButton) previousButton.hidden = !previous;
  }
  static details(markup) {
    const details = document.getElementById("modalDetails");
    if (details) details.innerHTML = markup;
  }
  static phaseLabel(message) {
    if (message === "Abrindo conexão USB" || message === "Confirmando modo de gravação") return "Conectando à placa";
    if (message === "Conferindo ESP32-S2 e capacidade da flash") return "Preparando a instalação";
    if (message.startsWith("Conferindo ")) return "Preparando os arquivos";
    if (message.endsWith(".bin") || message.startsWith("Gravando ")) return "Gravando na placa";
    if (message === "Verificando gravação na flash") return "Conferindo a instalação";
    if (message === "Encerrando conexão USB") return "Finalizando";
    return message;
  }
  static errorLabel(error) {
    if (!error) return "Nada foi gravado.";
    if (error.code === "TIMEOUT") return "A conexão não respondeu a tempo.";
    if (error.code === "DISCONNECTED") return "A conexão USB foi interrompida.";
    if (["MANIFEST", "DOWNLOAD", "IMAGE"].includes(error.code)) return "Não foi possível conferir os arquivos da instalação.";
    if (error.code === "ROM_ERROR") return "A placa não permitiu continuar.";
    if (error.code === "CANCELLED") return "A operação foi interrompida.";
    return "Confira os detalhes e tente novamente.";
  }
  constructor() {
    for (const id of ["installButton", "unsupportedText", "stageText", "hostpsmModal", "modalTitle", "modalBody", "modalClose", "modalPrimary", "modalSecondary", "modalDiagnostic"]) this[id] = document.getElementById(id);
    this.modal = this.hostpsmModal;
    this.busy = false;
    this.blocked = false;
    this.record = null;
    try { this.previous = JSON.parse(localStorage.getItem(LOG_KEY) || "null"); } catch (_) { this.previous = null; }
  }
  start() {
    this.supported = Boolean(navigator.serial && window.isSecureContext && crypto.subtle);
    this.installButton.disabled = !this.supported;
    this.unsupportedText.hidden = this.supported;
    if (!this.supported) this.stageText.textContent = "Este navegador não permite a instalação via USB.";
    this.installButton.addEventListener("click", () => { if (!this.busy && !this.blocked) runInstall(this); });
    this.modal.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.modalClose.hidden) { event.preventDefault(); this.modalClose.click(); }
      if (event.key !== "Tab") return;
      const buttons = [...this.modal.querySelectorAll("button:not([hidden]):not(:disabled), a[href], summary")].filter(button => button.getClientRects().length > 0);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
  }
  setBusy(value) {
    this.busy = value;
    this.installButton.disabled = value || !this.supported || this.blocked;
    this.installButton.textContent = this.blocked ? "Recarregue a página" : value ? "Aguarde" : "Instalar";
  }
  begin() {
    if (this.record) this.previous = this.record;
    this.record = {installer: INSTALLER_REVISION, session: crypto.randomUUID(), started: new Date().toISOString(),
      environment: navigator.userAgent, events: [], phase: "Preparação"};
    this.persist();
    this.heartbeat = setInterval(() => {
      this.record.heartbeat = new Date().toISOString();
      const elapsed = document.getElementById("modalElapsed");
      if (elapsed) elapsed.textContent = `Tempo nesta etapa: ${Math.floor((performance.now() - this.phaseStart) / 1000)} s`;
      this.persist();
    }, 1000);
  }
  persist() {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(this.record)); }
    catch (_) { /* Registro continua na tela/exportação quando armazenamento está indisponível. */ }
  }
  log(message) {
    this.record.events.push(`${new Date().toISOString()} ${message}`);
    if (this.record.events.length > 200) this.record.events.shift();
    this.persist();
    const log = document.getElementById("modalLog");
    if (log) { log.textContent = this.record.events.join("\n"); log.scrollTop = log.scrollHeight; }
  }
  phase(message) {
    this.currentPhase = message;
    this.phaseStart = performance.now();
    this.record.phase = message;
    this.log(`Etapa: ${message}.`);
    const node = document.getElementById("modalMessage");
    if (node) node.textContent = InstallerUi.phaseLabel(message);
    const elapsed = document.getElementById("modalElapsed");
    if (elapsed) elapsed.textContent = "Tempo nesta etapa: 0 s";
  }
  progress(ratio, label = "") {
    const shell = document.getElementById("progressShell"), bar = document.getElementById("modalProgress"), text = document.getElementById("modalPercent");
    if (!shell) return;
    shell.hidden = ratio === null;
    text.hidden = ratio === null;
    if (ratio === null) return;
    const pct = Math.max(0, Math.min(100, ratio * 100));
    bar.style.width = `${pct.toFixed(1)}%`;
    shell.setAttribute("aria-valuenow", pct.toFixed(1));
    text.textContent = `${Math.floor(pct)}%`;
  }
  openModal() {
    this.modal.classList.add("open"); this.modal.setAttribute("aria-hidden", "false");
    document.getElementById("root").inert = true;
  }
  closeModal(result) {
    this.modal.classList.remove("open"); this.modal.setAttribute("aria-hidden", "true");
    document.getElementById("root").inert = false;
    if (this.choiceResolve) { this.choiceResolve(result); this.choiceResolve = null; }
    this.installButton.focus();
  }
  exportLog(record = this.record) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2) + "\n"], {type: "application/json"}));
    const a = document.createElement("a"); a.href = url; a.download = `HostPSM-diagnostico-${record.session || "anterior"}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  choosePort() {
    InstallerUi.showView("connect", Boolean(this.previous));
    InstallerUi.details("");
    this.modalTitle.textContent = "Conectar ESP32-S2";
    this.modalBody.innerHTML = `<div class="connectInstruction">
      <svg class="uiIcon" aria-hidden="true"><use href="#usbIcon"/></svg>
      <p class="instructionText">Reconecte a placa segurando <kbd>BOOT/B0</kbd>.
      <span>Solte o botão antes de selecionar a porta.</span></p>
    </div>`;
    this.modalPrimary.textContent = "Selecionar porta";
    this.modalSecondary.textContent = "Cancelar";
    this.modalSecondary.title = "";
    this.modalDiagnostic.textContent = "Testar conexão";
    for (const button of [this.modalPrimary, this.modalSecondary, this.modalDiagnostic, this.modalClose]) { button.hidden = false; button.disabled = false; }
    const pick = diagnostic => {
      for (const button of [this.modalPrimary, this.modalSecondary, this.modalDiagnostic, this.modalClose]) button.disabled = true;
      this.log(`Seletor solicitado pelo clique; modo ${diagnostic ? "diagnóstico sem gravação" : "instalação"}.`);
      // A chamada nativa ocorre no próprio evento do botão, antes de qualquer await/fetch.
      let request;
      try { request = navigator.serial.requestPort(); }
      catch (error) { request = Promise.reject(error); }
      Promise.resolve(request).then(port => this.closeModal({port, diagnostic}), error => this.closeModal({error}));
    };
    this.modalPrimary.onclick = () => pick(false);
    this.modalDiagnostic.onclick = () => pick(true);
    this.modalSecondary.onclick = this.modalClose.onclick = () => this.closeModal(null);
    this.openModal(); this.modalPrimary.focus();
    const previousButton = document.getElementById("previousLog");
    if (previousButton) previousButton.onclick = () => this.exportLog(this.previous);
    return new Promise(resolve => { this.choiceResolve = resolve; });
  }
  openProgress(cancel) {
    InstallerUi.showView("progress");
    this.modalTitle.textContent = "Instalando Host PSM";
    this.modalBody.innerHTML = `<div class="progressPanel">
      <div class="progressTop"><p id="modalMessage" role="status" aria-live="polite"></p><p id="modalPercent" hidden></p></div>
      <div id="progressShell" class="progressShell" role="progressbar" aria-label="Dados confirmados" aria-valuemin="0" aria-valuemax="100" hidden><div id="modalProgress"></div></div>
      </div><p class="progressNote">Não desconecte a <strong>ESP32-S2</strong> durante a instalação.</p>`;
    InstallerUi.details(`<p id="modalElapsed"></p><pre id="modalLog" class="visible"></pre>`);
    this.modalPrimary.hidden = true; this.modalClose.hidden = true;
    this.modalDiagnostic.hidden = false; this.modalDiagnostic.disabled = false; this.modalDiagnostic.textContent = "Salvar registro";
    this.modalDiagnostic.onclick = () => this.exportLog();
    this.modalSecondary.hidden = false; this.modalSecondary.disabled = false; this.modalSecondary.textContent = "Interromper";
    this.modalSecondary.title = "Se interromper durante a gravação, será necessário instalar novamente.";
    this.modalSecondary.onclick = () => { this.modalSecondary.disabled = true; this.modalSecondary.textContent = "Encerrando…"; cancel(); };
    this.openModal(); this.modalSecondary.focus();
    this.phase("Preparando instalação");
  }
  finish({error, cleanup, verified, diagnostic, flashStarted, cancelled}) {
    clearInterval(this.heartbeat);
    this.blocked = cleanup && !cleanup.released;
    this.record.result = {error: error ? errorText(error) : null, cleanup, verified, diagnostic, flashStarted, cancelled};
    this.record.finished = new Date().toISOString();
    this.persist();
    this.setBusy(false);
    let title, body;
    if (verified) {
      InstallerUi.showView("success");
      title = this.blocked ? "Instalação verificada" : "Instalação concluída";
      body = `${this.blocked ? "" : '<p class="resultLead"><strong>ESP32-S2</strong> pronta para uso.</p><p class="ps5Label">NO PS5</p>'}
        <div class="networkDetails"><div class="networkItem"><span>Wi-Fi</span><strong>Conecte: HostPSM</strong></div>
        <div class="networkItem"><span>DNS</span><strong>Configure: 10.1.1.1</strong></div></div>
        <p class="nextStep">Depois, abra o <strong>Guia do Usuário.</strong></p>`;
    } else if (!error && diagnostic) {
      InstallerUi.showView(this.blocked ? "error" : "success");
      title = this.blocked ? "Conexão pendente" : "Conexão testada";
      body = '<p class="resultLead">A conexão USB respondeu. Nada foi gravado.</p>';
    } else {
      InstallerUi.showView(cancelled ? "cancelled" : "error");
      title = cancelled ? "Instalação cancelada" : diagnostic ? "Não foi possível conectar" : "Não foi possível concluir";
      body = `<p class="resultLead">${escapeHtml(InstallerUi.errorLabel(error))}</p>${flashStarted ? '<p class="resultNote">A instalação ficou incompleta. Reconecte com BOOT/B0 pressionado e instale novamente.</p>' : ""}`;
    }
    if (this.blocked) body += '<p class="resultNote">A conexão ainda não foi liberada. Reconecte a placa com BOOT liberado e recarregue esta página.</p>';
    this.stageText.textContent = verified ? "ESP32-S2 pronta para uso." : diagnostic && !error && !this.blocked ? "Conexão USB testada." : cancelled ? "Pronto para uma nova instalação." : "Confira o resultado para continuar.";
    this.modalTitle.textContent = title;
    this.modalBody.innerHTML = body;
    InstallerUi.details(`${error ? `<p>${escapeHtml(errorText(error))}</p>` : ""}${cleanup?.errors?.length ? `<p>${escapeHtml(cleanup.errors.join("; "))}</p>` : ""}<pre id="modalLog" class="visible"></pre>`);
    document.getElementById("modalLog").textContent = this.record.events.join("\n");
    this.modalPrimary.hidden = false; this.modalPrimary.disabled = false; this.modalPrimary.textContent = "Fechar";
    this.modalPrimary.onclick = this.modalClose.onclick = () => this.closeModal();
    this.modalClose.hidden = false; this.modalClose.disabled = false;
    this.modalSecondary.hidden = true;
    this.modalDiagnostic.hidden = false; this.modalDiagnostic.disabled = false; this.modalDiagnostic.textContent = "Salvar registro";
    this.modalDiagnostic.onclick = () => this.exportLog();
    this.openModal(); this.modalPrimary.focus();
  }
}
async function runInstall(ui) {
  if (ui.busy || ui.blocked) return;
  ui.setBusy(true); ui.begin();
  const controller = new AbortController();
  let flasher, error, cleanup = {released: true, errors: []}, diagnostic = false, cancelled = false;
  try {
    const choice = await ui.choosePort();
    if (!choice || choice.error?.name === "NotFoundError") { cancelled = true; return; }
    if (choice.error) throw choice.error;
    diagnostic = choice.diagnostic;
    const info = choice.port.getInfo();
    ui.record.port = {usbVendorId: info.usbVendorId, usbProductId: info.usbProductId};
    ui.log("Porta selecionada; VID/PID não comprovam modo BOOT.");
    ui.openProgress(() => controller.abort(fault("Interrompido pelo usuário.", "CANCELLED")));
    // Há um único proprietário da porta selecionada, mesmo durante os downloads.
    flasher = new HostPsmSerialFlasher(choice.port, ui, {signal: controller.signal});
    if (diagnostic) {
      await flasher.openPort();
      ui.log("Teste sem gravação: abertura e streams responderam; nenhum comando enviado.");
    } else {
      const manifest = await loadManifest(flasher.controller.signal);
      ui.record.build = {id: manifest.build_id, version: manifest.version};
      ui.log(`Build ${manifest.build_id}; versão ${manifest.version}; instalador ${INSTALLER_REVISION}.`);
      const parts = await loadFirmwareParts(ui, manifest.parts, flasher.controller.signal);
      await flasher.flash(parts);
    }
  } catch (cause) {
    error = cause; cancelled = cause.code === "CANCELLED";
    ui.log(`Falha na etapa ${ui.currentPhase || "seleção"}: ${errorText(cause)}`);
  } finally {
    if (flasher) cleanup = await flasher.closePort();
    ui.finish({error, cleanup, verified: Boolean(flasher?.verified), diagnostic,
      flashStarted: Boolean(flasher?.flashStarted), cancelled});
  }
}
export {ROM, LIMITS, LAYOUT, FLASH_BYTES, SlipFrameReader, HostPsmSerialFlasher, InstallerUi,
  bounded, parseResponse, slipEncode, makePacket, u32Packet, flashChecksum,
  validateManifest, validateImages, fetchBytes, loadManifest, loadFirmwareParts, runInstall};
if (typeof document !== "undefined") { const ui = new InstallerUi(); ui.start(); }
