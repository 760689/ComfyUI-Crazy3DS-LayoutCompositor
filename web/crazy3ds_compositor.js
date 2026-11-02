import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 全局会话内存池
window._crazy3ds_memory_store = window._crazy3ds_memory_store || {};

app.registerExtension({
    name: "Crazy3DS.LayoutCompositor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Crazy3DS_LayoutCompositor") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            const nodeInstance = this;

            const fileWidget = this.widgets?.find(w => w.name === "image_name");
            if (fileWidget) {
                fileWidget.type = "hidden";
                fileWidget.computeSize = () => [0, -4];
                fileWidget.draw = () => {};
            }

            // 全局交互反馈样式：悬停提亮、按下压暗下沉、点击后一圈青色扩散确认（只注入一次）
            if (!document.getElementById("crazy3ds-ui-styles")) {
                const styleEl = document.createElement("style");
                styleEl.id = "crazy3ds-ui-styles";
                styleEl.textContent = `
                    .c3ds-btn { transition: filter .1s ease, transform .06s ease, background-color .12s ease, border-color .12s ease; }
                    .c3ds-btn:hover { filter: brightness(1.32); }
                    .c3ds-btn:active { filter: brightness(0.6); transform: translateY(1px) scale(.955); }
                    .c3ds-btn:focus-visible { outline: 1px solid #00e5ff; outline-offset: 1px; }
                    .c3ds-dot { transition: filter .1s ease; }
                    .c3ds-dot:hover { outline: 2px solid rgba(0, 229, 255, 0.9); outline-offset: 1px; }
                    .c3ds-dot:active { outline: 2px solid #ffffff; outline-offset: 1px; filter: brightness(0.65); }
                    .c3ds-select { transition: filter .1s ease; }
                    .c3ds-select:hover { filter: brightness(1.28); }
                    .c3ds-select:active { filter: brightness(0.75); }
                    @keyframes c3dsFlash {
                        0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.9); }
                        100% { box-shadow: 0 0 0 7px rgba(0, 229, 255, 0); }
                    }
                    .c3ds-flash { animation: c3dsFlash .3s ease-out; }
                `;
                document.head.appendChild(styleEl);
            }

            const BASE_RATIOS = {
                "3:4": [768, 1024],
                "1:1": [1024, 1024],
                "4:3": [1024, 768],
                "16:9": [1024, 576],
                "9:16": [576, 1024]
            };

            const MULTIPLIERS = {
                "1K": 1,
                "2K": 2,
                "4K": 4,
                "8K": 8
            };

            const state = {
                tool: "brush",             // "brush" | "eraser" | "select" | "layer_eraser" | "eyedropper"
                ratio: "3:4",
                scaleTier: "2K",
                brushColor: "#000000",
                brushSize: 20,
                layerEraserSize: 35,
                brushOpacity: 1.0,
                selectedLayerIndex: -1,
                selectedLayerIndices: [],
                layers: [],
                history: [],
                redoStack: [],
                isInteracting: false,
                hasModified: false,        // 追踪交互期间是否真正产生画布/图层变更，避免空点触发耗时上传
                actionType: null,          // "drag_layer" | "resize_layer" | "paint" | "box_select" | "rotate_layer"
                resizeCorner: null,
                mousePos: { x: -100, y: -100 },
                boxSelectRect: null,
                cropMode: false,           // 是否处于图层裁剪模式
                cropLayerId: null,         // 裁剪模式绑定的图层 id
                cropRect: null,            // 裁剪框，单位为图层原始像素 {x, y, w, h}
                cropRatioLock: null,       // 裁剪比例锁，null 为自由裁剪
                cropAction: null,          // "move" | "resize"
                cropHandle: null,          // "tl" | "t" | "tr" | "l" | "r" | "bl" | "b" | "br"
                cropInitRect: null,
                cropInitPointer: null,
                prevTool: null
            };

            let rafPending = false;
            let currentLayout = { dispW: 400, dispH: 400, dispX: 0, dispY: 0, scale: 1 };

            // ── 统一历史快照：位移 / 缩放 / 旋转 / 镜像 / 透明度 / 层级 / 增删 全部可撤销重做 ──
            const captureLayerSnapshot = () => ({
                refs: state.layers.slice(),
                meta: state.layers.map(l => ({
                    id: l.id,
                    x: l.x, y: l.y, w: l.w, h: l.h,
                    rotation: l.rotation || 0,
                    flipH: !!l.flipH,
                    opacity: l.opacity !== undefined ? l.opacity : 1.0
                }))
            });

            let pendingSnapshot = null;

            const pushHistoryEntry = (entry) => {
                if (state.history.length >= 15) state.history.shift();
                state.history.push(entry);
                state.redoStack = [];
            };

            // 立即记录一份“操作前”图层快照（用于按钮类一次性操作）
            const pushLayerSnapshot = () => {
                pendingSnapshot = null;
                pushHistoryEntry({ type: "snapshot", snap: captureLayerSnapshot() });
            };

            // 拖拽类操作：按下时暂存，首次真实位移时才提交，避免空点占位
            const beginLayerSnapshot = () => {
                pendingSnapshot = captureLayerSnapshot();
            };

            const commitLayerSnapshot = () => {
                if (!pendingSnapshot) return;
                const snap = pendingSnapshot;
                pendingSnapshot = null;
                pushHistoryEntry({ type: "snapshot", snap });
            };

            const restoreLayerSnapshot = (snap) => {
                const prevIds = new Set(state.layers.map(l => l.id));
                state.layers = snap.refs.slice();
                state.layers.forEach(l => {
                    if (!prevIds.has(l.id)) l._needsUpload = true;
                });
                snap.meta.forEach(m => {
                    const l = state.layers.find(item => item.id === m.id);
                    if (!l) return;
                    l.x = m.x; l.y = m.y; l.w = m.w; l.h = m.h;
                    l.rotation = m.rotation; l.flipH = m.flipH; l.opacity = m.opacity;
                });
                state.selectedLayerIndices = state.selectedLayerIndices.filter(i => i < state.layers.length);
                if (state.selectedLayerIndex >= state.layers.length) {
                    state.selectedLayerIndex = state.layers.length - 1;
                }
            };

            // ── 图层裁剪核心逻辑 ──
            const CROP_MIN_PX = 16;

            const getCropTargetLayer = () => (state.selectedLayerIndex >= 0 ? state.layers[state.selectedLayerIndex] : null);

            // 在 (ow, oh) 内取最大的、居中、长宽比为 r 的矩形
            const fitRatioInRect = (ow, oh, r) => {
                let w = ow, h = w / r;
                if (h > oh) { h = oh; w = h * r; }
                return { x: (ow - w) / 2, y: (oh - h) / 2, w, h };
            };

            const clampCropRect = (rect, ow, oh, lock) => {
                let w = Math.max(CROP_MIN_PX, rect.w);
                let h = Math.max(CROP_MIN_PX, rect.h);
                if (lock) {
                    if (w / h > lock) w = h * lock; else h = w / lock;
                    if (w > ow) { w = ow; h = w / lock; }
                    if (h > oh) { h = oh; w = h * lock; }
                } else {
                    w = Math.min(w, ow);
                    h = Math.min(h, oh);
                }
                const x = Math.min(Math.max(0, rect.x), Math.max(0, ow - w));
                const y = Math.min(Math.max(0, rect.y), Math.max(0, oh - h));
                return { x, y, w, h };
            };

            // 图层像素坐标 → 图像绘制盒坐标（未翻转，范围 -w/2..w/2）
            const cropRectToDrawBox = (layer, rect) => ({
                x: (rect.x / layer.origW - 0.5) * layer.w,
                y: (rect.y / layer.origH - 0.5) * layer.h,
                w: (rect.w / layer.origW) * layer.w,
                h: (rect.h / layer.origH) * layer.h
            });

            // 画板坐标 → 图像绘制盒坐标（已抵消 flipH，可直接与 cropRectToDrawBox 比较）
            const canvasPosToDrawBox = (pos, layer) => {
                const box = toLayerBoxCoords(pos, layer);
                const fx = layer.flipH ? -1 : 1;
                return { x: box.rx * fx, y: box.ry };
            };

            // 真正执行裁剪：换掉图层画布、改写原图尺寸，并保持画面上的视觉位置与缩放不变
            const cropLayerToRect = (layer, rect) => {
                const ow = layer.origW, oh = layer.origH;
                if (!ow || !oh) return false;

                const c = clampCropRect(rect, ow, oh, null);
                const rx = Math.round(c.x), ry = Math.round(c.y);
                const rw = Math.round(c.w), rh = Math.round(c.h);
                if (rw < 2 || rh < 2) return false;
                if (rx <= 0 && ry <= 0 && rw >= ow && rh >= oh) return false; // 无实际变化

                const before = {
                    canvas: layer.canvas, ctx: layer.ctx,
                    origW: ow, origH: oh,
                    x: layer.x, y: layer.y, w: layer.w, h: layer.h
                };

                const nc = document.createElement("canvas");
                nc.width = rw; nc.height = rh;
                const nctx = nc.getContext("2d", { willReadFrequently: true });
                nctx.imageSmoothingEnabled = true;
                nctx.imageSmoothingQuality = "high";
                nctx.drawImage(layer.canvas, rx, ry, rw, rh, 0, 0, rw, rh);

                const cx = layer.x + layer.w / 2;
                const cy = layer.y + layer.h / 2;
                const rad = ((layer.rotation || 0) * Math.PI) / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const fx = layer.flipH ? -1 : 1;

                const ccx = rx + rw / 2, ccy = ry + rh / 2;
                const bx = fx * ((ccx / ow - 0.5) * layer.w);
                const by = (ccy / oh - 0.5) * layer.h;
                const ncx = cx + (bx * cos - by * sin);
                const ncy = cy + (bx * sin + by * cos);

                const nw = layer.w * (rw / ow);
                const nh = layer.h * (rh / oh);

                layer.canvas = nc; layer.ctx = nctx;
                layer.origW = rw; layer.origH = rh;
                layer.w = nw; layer.h = nh;
                layer.x = ncx - nw / 2;
                layer.y = ncy - nh / 2;
                layer._needsUpload = true;

                pushHistoryEntry({
                    type: "canvas",
                    layerId: layer.id,
                    before,
                    after: {
                        canvas: nc, ctx: nctx,
                        origW: rw, origH: rh,
                        x: layer.x, y: layer.y, w: nw, h: nh
                    }
                });
                return true;
            };

            const root = document.createElement("div");
            root.style.cssText = `
                position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;
                background: #141414; border-radius: 6px; overflow: visible; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px; color: #ddd; user-select: none;
            `;

            // 顶栏工具栏
            const hud = document.createElement("div");
            hud.style.cssText = `
                display: flex; gap: 4px; padding: 4px 6px; background: #1c1c1c;
                border-bottom: 1px solid #333; z-index: 10; flex-shrink: 0; align-items: center; justify-content: space-between;
                border-top-left-radius: 6px; border-top-right-radius: 6px;
            `;

            // 隔离顶栏指针事件：防止点击按钮/下拉菜单时事件冒泡给 LiteGraph 画布引发抢焦点或吞点击，同时保留中键/空格平移画布能力
            hud.addEventListener("pointerdown", (e) => {
                if (e.button === 1 || (e.button === 0 && (app.canvas?.space_is_pressed || e.spaceKey))) {
                    isForwardingPan = true;
                    if (app.canvas?.canvas) app.canvas.canvas.dispatchEvent(new PointerEvent("pointerdown", e));
                    e.preventDefault();
                    return;
                }
                e.stopPropagation();
            });
            hud.addEventListener("contextmenu", (e) => e.stopPropagation());

            const btnGroupLeft = document.createElement("div");
            btnGroupLeft.style.cssText = "display: flex; gap: 3px; align-items: center; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;";

            const createBtn = (label, active = false, tooltip = "") => {
                const b = document.createElement("button");
                b.textContent = label;
                if (tooltip) b.title = tooltip;
                b.style.cssText = `
                    padding: 0.27em 0.55em; cursor: pointer; border-radius: 3px; border: 1px solid #444;
                    background: ${active ? "#0066cc" : "#2a2a2a"}; color: #fff; font-size: 1em; font-family: inherit;
                    outline: none; white-space: nowrap; flex-shrink: 0; line-height: 1.27em;
                `;
                b.className = "c3ds-btn";
                b.addEventListener("click", () => {
                    b.classList.remove("c3ds-flash");
                    void b.offsetWidth; // 强制重排以重启动画
                    b.classList.add("c3ds-flash");
                    setTimeout(() => b.classList.remove("c3ds-flash"), 320);
                });
                return b;
            };

            const applySleekSlider = (slider, width = "115px") => {
                slider.style.cssText = `
                    -webkit-appearance: none; appearance: none; width: ${width}; height: 3px;
                    background: #333; border-radius: 2px; outline: none; cursor: pointer;
                    accent-color: #0088ff; margin: 4px 0;
                `;
            };

            const btnBrush = createBtn("✎ 画", true, "画笔：在画板上手绘（再次点击或右键可退出）");
            const btnSelect = createBtn("✥ 移", false, "移动图层：选择、平移与缩放图层（支持单选、Shift多选、Alt穿透下钻、拉框多选）");
            const btnImport = createBtn("⮮ 导", false, "导入图片：从本地导入图片素材");
            const btnFetchUpstream = createBtn("✜ 读", false, "读取输入：直接载入上游输入插槽连接的图像（上游输出多张时批量载入为多个图层）");

            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.multiple = true;
            fileInput.accept = "image/*";
            fileInput.style.display = "none";
            btnImport.onclick = () => fileInput.click();

            const ratioSelect = document.createElement("select");
            ratioSelect.className = "c3ds-select";
            ratioSelect.title = "画板比例：切换画板长宽比（自动居中，不挤压素材内容）";
            ratioSelect.style.cssText = "background: #2a2a2a; border: 1px solid #444; color: #00e5ff; font-size: 1em; font-family: inherit; line-height: 1.3em; padding: 0.18em 0.36em; border-radius: 3px; outline: none; flex-shrink: 0;";
            ["3:4", "1:1", "4:3", "16:9", "9:16"].forEach(r => {
                const o = document.createElement("option");
                o.value = r;
                o.textContent = r;
                ratioSelect.appendChild(o);
            });
            ratioSelect.value = state.ratio;

            const scaleSelect = document.createElement("select");
            scaleSelect.className = "c3ds-select";
            scaleSelect.title = "分辨率档位：切换画板物理渲染分辨率（1K / 2K / 4K / 8K）";
            scaleSelect.style.cssText = "background: #2a2a2a; border: 1px solid #444; color: #ffb700; font-size: 1em; font-family: inherit; line-height: 1.3em; padding: 0.18em 0.36em; border-radius: 3px; outline: none; flex-shrink: 0;";
            ["2K", "1K", "4K", "8K"].forEach(s => {
                const o = document.createElement("option");
                o.value = s;
                o.textContent = s;
                scaleSelect.appendChild(o);
            });
            scaleSelect.value = state.scaleTier;

            const bgSelect = document.createElement("select");
            bgSelect.className = "c3ds-select";
            bgSelect.title = "画板底色：设置画板背景底色（白底 / 黑底 / 中灰 / 透明）";
            bgSelect.style.cssText = "background: #2a2a2a; border: 1px solid #444; color: #fff; font-size: 1em; font-family: inherit; line-height: 1.3em; padding: 0.18em 0.36em; border-radius: 3px; outline: none; flex-shrink: 0;";
            ["white:白底", "black:黑底", "gray:中灰", "transparent:透明"].forEach(opt => {
                const [val, text] = opt.split(":");
                const o = document.createElement("option");
                o.value = val;
                o.textContent = text;
                bgSelect.appendChild(o);
            });

            // 顶栏字号跟随节点宽度自适应：默认宽度下与导航栏完全一致，节点拉大时同步放大
            const HUD_BASE_FONT = 11;
            const HUD_BASE_WIDTH = 600;
            const HUD_MAX_FONT = 15;
            const hudSelects = [ratioSelect, scaleSelect, bgSelect];
            const applyHudFontScale = () => {
                const w = root.clientWidth || HUD_BASE_WIDTH;
                const fs = Math.max(HUD_BASE_FONT, Math.min(HUD_MAX_FONT, HUD_BASE_FONT * (w / HUD_BASE_WIDTH)));
                const fsStr = `${fs.toFixed(2)}px`;
                if (hud.dataset.fontSize === fsStr) return;
                hud.dataset.fontSize = fsStr;
                hud.style.fontSize = fsStr;
                hudSelects.forEach(sel => {
                    Array.from(sel.options).forEach(o => {
                        o.style.fontSize = fsStr;
                        o.style.fontFamily = "inherit";
                    });
                });
            };

            btnGroupLeft.appendChild(btnBrush);
            btnGroupLeft.appendChild(btnSelect);
            btnGroupLeft.appendChild(btnImport);
            btnGroupLeft.appendChild(fileInput);
            btnGroupLeft.appendChild(btnFetchUpstream);
            btnGroupLeft.appendChild(ratioSelect);
            btnGroupLeft.appendChild(scaleSelect);
            btnGroupLeft.appendChild(bgSelect);

            const btnGroupRight = document.createElement("div");
            btnGroupRight.style.cssText = "display: flex; gap: 3px; align-items: center; flex-wrap: nowrap; flex-shrink: 0;";
            const btnPanelToggle = createBtn("⮻功能参数", false, "参数设置：展开/收起参数悬浮卡片（按住标题栏可拖拽）");
            const btnSave = createBtn("☑︎存", false, "保存图片：将当前排版合成画面以原始最高分辨率导出下载为PNG");
            const btnUndo = createBtn("⮌撤", false, "撤销 (Ctrl+Z)");
            const btnRedo = createBtn("⮎重", false, "重做 (Ctrl+Y)");
            const btnClear = createBtn("⮿清", false, "清空画布：清空所有图层、画笔手绘及临时缓存");
            btnClear.style.borderColor = "#882222";
            btnClear.style.background = "#441111";

            btnGroupRight.appendChild(btnPanelToggle);
            btnGroupRight.appendChild(btnSave);
            btnGroupRight.appendChild(btnUndo);
            btnGroupRight.appendChild(btnRedo);
            btnGroupRight.appendChild(btnClear);

            hud.appendChild(btnGroupLeft);
            hud.appendChild(btnGroupRight);
            root.appendChild(hud);

            // 悬浮参数功能卡
            const popover = document.createElement("div");
            popover.style.cssText = `
                position: absolute; top: 32px; right: 8px; width: 236px; background: rgba(22, 22, 22, 0.96);
                backdrop-filter: blur(8px); border: 1px solid #444; border-radius: 6px; padding: 8px 10px;
                display: none; flex-direction: column; gap: 8px; z-index: 1000; box-shadow: 0 8px 24px rgba(0,0,0,0.85);
                max-height: calc(100% - 44px); overflow-y: auto; overscroll-behavior: contain;
            `;

            // 面板区域内同样允许用中键拖动 / 滚轮缩放 ComfyUI 画布
            popover.addEventListener("pointerdown", (e) => {
                if (e.button === 1 || (e.button === 0 && (app.canvas?.space_is_pressed || e.spaceKey))) {
                    isForwardingPan = true;
                    if (app.canvas?.canvas) app.canvas.canvas.dispatchEvent(new PointerEvent("pointerdown", e));
                    e.preventDefault();
                    return;
                }
                e.stopPropagation();
            });
            popover.addEventListener("wheel", (e) => {
                e.stopPropagation();
                // 面板自身内容超出需要滚动时，滚轮优先滚动面板；否则交给画布做缩放
                if (popover.scrollHeight > popover.clientHeight + 4) return;
                if (app.canvas?.canvas) {
                    app.canvas.canvas.dispatchEvent(new WheelEvent("wheel", {
                        clientX: e.clientX, clientY: e.clientY,
                        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
                        deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
                        altKey: e.altKey, bubbles: true, cancelable: true
                    }));
                }
            }, { passive: true });
            popover.addEventListener("contextmenu", (e) => e.stopPropagation());

            const popHeader = document.createElement("div");
            popHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 4px; cursor: move; user-select: none;";
            popHeader.innerHTML = `<span style="font-weight: 600; color: #fff; display: flex; align-items: center; gap: 4px;" title="按住可拖动此面板到任意位置"><span style="color:#777; font-size:12px;">⠿</span> 画笔与图层参数</span>`;
            const popClose = document.createElement("span");
            popClose.textContent = "✕";
            popClose.className = "c3ds-btn";
            popClose.title = "关闭参数面板";
            popClose.style.cssText = "cursor: pointer; color: #888; font-size: 12px; padding: 0 4px; display: inline-block;";
            popClose.onclick = () => { popover.style.display = "none"; };
            popHeader.appendChild(popClose);
            popover.appendChild(popHeader);

            let isDraggingPop = false;
            let dragStartMouse = { x: 0, y: 0 };
            let dragStartOffset = { x: 0, y: 0 };

            popHeader.addEventListener("pointerdown", (e) => {
                if (e.target === popClose) return;
                isDraggingPop = true;
                dragStartMouse = { x: e.clientX, y: e.clientY };
                dragStartOffset = { x: popover.offsetLeft, y: popover.offsetTop };
                popHeader.setPointerCapture(e.pointerId);
                e.stopPropagation();
            });

            popHeader.addEventListener("pointermove", (e) => {
                if (!isDraggingPop) return;
                const zoom = app.canvas?.ds?.scale || 1.0;
                const dx = (e.clientX - dragStartMouse.x) / zoom;
                const dy = (e.clientY - dragStartMouse.y) / zoom;
                popover.style.right = "auto";
                popover.style.left = `${dragStartOffset.x + dx}px`;
                popover.style.top = `${dragStartOffset.y + dy}px`;
                e.stopPropagation();
            });

            const stopPopDrag = (e) => {
                if (isDraggingPop) {
                    isDraggingPop = false;
                    try { popHeader.releasePointerCapture(e.pointerId); } catch (_) {}
                    e.stopPropagation();
                }
            };
            popHeader.addEventListener("pointerup", stopPopDrag);
            popHeader.addEventListener("pointercancel", stopPopDrag);

            const brushCtrlRow = document.createElement("div");
            brushCtrlRow.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

            const brushModeRow = document.createElement("div");
            brushModeRow.style.cssText = "display: flex; gap: 5px; align-items: center;";
            const btnSubBrush = createBtn("笔 刷", true, "画笔：手绘线条（再次点击或右键可退出）");
            const btnSubEraser = createBtn("橡皮擦", false, "橡皮擦：擦除手绘线条（再次点击或右键可退出）");
            const btnSubClearDraw = createBtn("清除手绘", false, "清空手绘：一键清空所有画笔手绘笔触，保留图片图层");
            btnSubClearDraw.onclick = () => {
                if (state.history.length >= 15) state.history.shift();
                state.history.push({
                    type: "draw",
                    data: drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)
                });
                state.redoStack = [];

                drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                requestScreenRender();
                debouncedSave();
            };

            brushModeRow.appendChild(btnSubBrush);
            brushModeRow.appendChild(btnSubEraser);
            brushModeRow.appendChild(btnSubClearDraw);
            brushCtrlRow.appendChild(brushModeRow);

            const brushSizeRow = document.createElement("div");
            brushSizeRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
            const brushSizeVal = document.createElement("span");
            brushSizeVal.textContent = `粗细: ${state.brushSize}px`;
            const brushSizeSlider = document.createElement("input");
            brushSizeSlider.type = "range"; brushSizeSlider.min = "1"; brushSizeSlider.max = "150";
            brushSizeSlider.value = state.brushSize;
            brushSizeSlider.title = "调节画笔与手绘橡皮的粗细 (px)";
            applySleekSlider(brushSizeSlider);
            brushSizeSlider.oninput = (e) => {
                state.brushSize = parseInt(e.target.value, 10);
                brushSizeVal.textContent = `粗细: ${state.brushSize}px`;
            };
            brushSizeRow.appendChild(brushSizeVal);
            brushSizeRow.appendChild(brushSizeSlider);

            const brushOpRow = document.createElement("div");
            brushOpRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
            const brushOpVal = document.createElement("span");
            brushOpVal.textContent = `不透明: 100%`;
            const brushOpSlider = document.createElement("input");
            brushOpSlider.type = "range"; brushOpSlider.min = "5"; brushOpSlider.max = "100";
            brushOpSlider.value = "100";
            brushOpSlider.title = "调节画笔绘制时的不透明度 (%)";
            applySleekSlider(brushOpSlider);
            brushOpSlider.oninput = (e) => {
                state.brushOpacity = parseInt(e.target.value, 10) / 100.0;
                brushOpVal.textContent = `不透明: ${e.target.value}%`;
            };
            brushOpRow.appendChild(brushOpVal);
            brushOpRow.appendChild(brushOpSlider);

            brushCtrlRow.appendChild(brushSizeRow);
            brushCtrlRow.appendChild(brushOpRow);
            popover.appendChild(brushCtrlRow);

            const colorPaletteWrap = document.createElement("div");
            colorPaletteWrap.style.cssText = "display: flex; gap: 4px; align-items: center; justify-content: space-between;";
            const semanticColors = ["#000000", "#FFFFFF", "#FF0000", "#00E676", "#2979FF", "#FFEA00", "#D500F9"];
            const colorDoms = [];
            const updateActiveColorUI = () => {
                colorDoms.forEach(cd => {
                    if (cd.dataset.color.toLowerCase() === state.brushColor.toLowerCase()) {
                        cd.style.boxShadow = "0 0 0 2px #fff, 0 0 4px rgba(0,0,0,0.9)";
                        cd.style.transform = "scale(1.15)";
                    } else {
                        cd.style.boxShadow = "none";
                        cd.style.transform = "scale(1)";
                    }
                });
            };

            semanticColors.forEach(hex => {
                const dot = document.createElement("div");
                dot.className = "c3ds-dot";
                dot.dataset.color = hex;
                dot.title = `切换画笔颜色: ${hex}`;
                dot.style.cssText = `width: 14px; height: 14px; background: ${hex}; border: 1px solid #555; border-radius: 2px; cursor: pointer; transition: all 0.15s ease;`;
                dot.onclick = () => {
                    state.brushColor = hex;
                    state.tool = "brush";
                    updateBtns();
                    updateActiveColorUI();
                };
                colorDoms.push(dot);
                colorPaletteWrap.appendChild(dot);
            });

            const nativeColor = document.createElement("input");
            nativeColor.type = "color";
            nativeColor.value = state.brushColor;
            nativeColor.title = "自定义选取画笔颜色";
            nativeColor.style.cssText = "width: 18px; height: 18px; border: none; padding: 0; cursor: pointer;";
            nativeColor.oninput = (e) => {
                state.brushColor = e.target.value;
                state.tool = "brush";
                updateBtns();
                updateActiveColorUI();
            };
            const btnEyedropper = createBtn("取色", false, "吸管取色：在画板上拾取颜色，取色后自动切回画笔");

            colorPaletteWrap.appendChild(nativeColor);
            colorPaletteWrap.appendChild(btnEyedropper);
            popover.appendChild(colorPaletteWrap);

            // 分割线
            const brushLayerDivider = document.createElement("div");
            brushLayerDivider.style.cssText = "height: 1px; background: rgba(255, 255, 255, 0.15); margin: 3px 0;";
            popover.appendChild(brushLayerDivider);

            const layerCtrlSection = document.createElement("div");
            layerCtrlSection.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

            const btnSubLayerEraser = createBtn("✂ 图层自由擦除", false, "图层自由擦除：直接在选中的图片上擦除像素使其透明（再次点击或右键可退出）");
            btnSubLayerEraser.style.width = "100%";
            layerCtrlSection.appendChild(btnSubLayerEraser);

            const layerEraserSizeRow = document.createElement("div");
            layerEraserSizeRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
            const layerEraserSizeVal = document.createElement("span");
            layerEraserSizeVal.textContent = `擦除粗细: ${state.layerEraserSize}px`;
            layerEraserSizeVal.style.color = "#aaa";
            const layerEraserSizeSlider = document.createElement("input");
            layerEraserSizeSlider.type = "range"; layerEraserSizeSlider.min = "1"; layerEraserSizeSlider.max = "150";
            layerEraserSizeSlider.value = state.layerEraserSize;
            layerEraserSizeSlider.title = "调节图层擦除专属粗细 (px)";
            applySleekSlider(layerEraserSizeSlider);
            layerEraserSizeSlider.oninput = (e) => {
                state.layerEraserSize = parseInt(e.target.value, 10);
                layerEraserSizeVal.textContent = `擦除粗细: ${state.layerEraserSize}px`;
                requestScreenRender();
            };
            layerEraserSizeRow.appendChild(layerEraserSizeVal);
            layerEraserSizeRow.appendChild(layerEraserSizeSlider);
            layerCtrlSection.appendChild(layerEraserSizeRow);

            const layerOpRow = document.createElement("div");
            layerOpRow.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
            const layerOpLabel = document.createElement("span");
            layerOpLabel.textContent = "图层透明度:";
            const layerOpSlider = document.createElement("input");
            layerOpSlider.type = "range"; layerOpSlider.min = "0"; layerOpSlider.max = "100";
            layerOpSlider.value = "100";
            layerOpSlider.title = "调节当前选中图层的不透明度 (%)";
            applySleekSlider(layerOpSlider);
            layerOpSlider.oninput = (e) => {
                const targetIndices = state.selectedLayerIndices.length > 0 ? state.selectedLayerIndices : (state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : []);
                if (targetIndices.length === 0) return;
                if (!pendingSnapshot) beginLayerSnapshot();
                targetIndices.forEach(idx => {
                    if (state.layers[idx]) state.layers[idx].opacity = parseInt(e.target.value, 10) / 100.0;
                });
                requestScreenRender();
                debouncedSave();
            };
            layerOpSlider.onchange = () => commitLayerSnapshot();
            layerOpRow.appendChild(layerOpLabel);
            layerOpRow.appendChild(layerOpSlider);
            layerCtrlSection.appendChild(layerOpRow);

            // 图层变换按钮整齐排列为单一横排
            const layerBtnRow = document.createElement("div");
            layerBtnRow.style.cssText = "display: flex; gap: 4px; justify-content: space-between; flex-wrap: nowrap;";

            const btnRotate = createBtn("↻ 旋转", false, "顺时针旋转90°");
            const btnFlipH = createBtn("⇄ 镜像", false, "水平镜像翻转图层");
            const btnLayerUp = createBtn("↑ 置顶", false, "图层置顶：移至最上层");
            const btnLayerDown = createBtn("↓ 置底", false, "图层置底：移至最底层");

            [btnRotate, btnFlipH, btnLayerUp, btnLayerDown].forEach(b => {
                b.style.flex = "1";
                b.style.padding = "3px 2px";
                b.style.textAlign = "center";
                layerBtnRow.appendChild(b);
            });

            btnRotate.onclick = () => {
                const targetIndices = state.selectedLayerIndices.length > 0 ? state.selectedLayerIndices : (state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : []);
                if (targetIndices.length === 0) return;
                pushLayerSnapshot();
                targetIndices.forEach(idx => {
                    const sel = state.layers[idx];
                    if (sel) sel.rotation = ((sel.rotation || 0) + 90) % 360;
                });
                syncRotationSlider();
                requestScreenRender();
                debouncedSave();
            };

            btnFlipH.onclick = () => {
                const targetIndices = state.selectedLayerIndices.length > 0 ? state.selectedLayerIndices : (state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : []);
                if (targetIndices.length === 0) return;
                pushLayerSnapshot();
                targetIndices.forEach(idx => {
                    const sel = state.layers[idx];
                    if (sel) sel.flipH = !sel.flipH;
                });
                requestScreenRender();
                debouncedSave();
            };

            btnLayerUp.onclick = () => {
                if (state.selectedLayerIndex >= 0 && state.selectedLayerIndex < state.layers.length - 1) {
                    pushLayerSnapshot();
                    const item = state.layers.splice(state.selectedLayerIndex, 1)[0];
                    state.layers.push(item);
                    state.selectedLayerIndex = state.layers.length - 1;
                    state.selectedLayerIndices = [state.selectedLayerIndex];
                    requestScreenRender();
                    debouncedSave();
                }
            };

            btnLayerDown.onclick = () => {
                if (state.selectedLayerIndex > 0) {
                    pushLayerSnapshot();
                    const item = state.layers.splice(state.selectedLayerIndex, 1)[0];
                    state.layers.unshift(item);
                    state.selectedLayerIndex = 0;
                    state.selectedLayerIndices = [0];
                    requestScreenRender();
                    debouncedSave();
                }
            };

            layerCtrlSection.appendChild(layerBtnRow);

            // 自由旋转滑杆：任意角度精确旋转选中图层（不再局限于 90° 整数倍）
            const getActiveLayerIndices = () => {
                if (state.selectedLayerIndices.length > 0) return [...state.selectedLayerIndices];
                return state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : [];
            };
            const normalizeDeg = (deg) => (((deg || 0) % 360) + 360) % 360;

            const rotRow = document.createElement("div");
            rotRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; gap: 6px;";
            const rotLabel = document.createElement("span");
            rotLabel.style.color = "#aaa";
            rotLabel.style.whiteSpace = "nowrap";
            rotLabel.textContent = "旋转: 0°";
            rotLabel.title = "自由旋转：拖动滑块可任意角度旋转选中图层（按住 Shift 拖动吸附 15° 整数倍）";
            const rotSlider = document.createElement("input");
            rotSlider.type = "range"; rotSlider.min = "0"; rotSlider.max = "359"; rotSlider.step = "1";
            rotSlider.value = "0";
            rotSlider.title = "自由旋转：任意角度旋转选中图层，按住 Shift 拖动可吸附 15° 整数倍";
            applySleekSlider(rotSlider, "120px");

            const syncRotationSlider = () => {
                const idx = state.selectedLayerIndex >= 0 ? state.selectedLayerIndex : (state.selectedLayerIndices[0] ?? -1);
                const l = state.layers[idx];
                const deg = l ? Math.min(359, Math.round(normalizeDeg(l.rotation))) : 0;
                rotSlider.value = String(deg);
                rotLabel.textContent = `旋转: ${deg}°`;
            };

            rotSlider.oninput = (e) => {
                const targetIndices = getActiveLayerIndices();
                if (targetIndices.length === 0) return;
                if (!pendingSnapshot) beginLayerSnapshot();
                let deg = parseInt(e.target.value, 10);
                if (isNaN(deg)) deg = 0;
                if (e.shiftKey) deg = Math.round(deg / 15) * 15;
                deg = Math.max(0, Math.min(359, deg));
                targetIndices.forEach(idx => {
                    if (state.layers[idx]) state.layers[idx].rotation = deg;
                });
                rotLabel.textContent = `旋转: ${deg}°`;
                requestScreenRender();
                debouncedSave();
            };
            rotSlider.onchange = () => { commitLayerSnapshot(); syncRotationSlider(); };

            rotRow.appendChild(rotLabel);
            rotRow.appendChild(rotSlider);
            layerCtrlSection.appendChild(rotRow);

            // ── 图层裁剪 ──
            const cropDivider = document.createElement("div");
            cropDivider.style.cssText = "height: 1px; background: rgba(255, 255, 255, 0.15); margin: 3px 0;";
            layerCtrlSection.appendChild(cropDivider);

            const cropTitle = document.createElement("span");
            cropTitle.textContent = "✂ 图层裁剪 (比例裁剪 / 自定义裁剪):";
            cropTitle.style.color = "#888";
            cropTitle.style.fontSize = "10px";
            cropTitle.title = "对选中图层裁剪：先选比例进入裁剪模式，再在画板上自由拖拽/缩放裁剪框，确认后应用（可撤销）";
            layerCtrlSection.appendChild(cropTitle);

            const CROP_PRESETS = [
                { label: "1:1", r: 1 },
                { label: "4:3", r: 4 / 3 },
                { label: "3:4", r: 3 / 4 },
                { label: "16:9", r: 16 / 9 },
                { label: "9:16", r: 9 / 16 }
            ];

            const cropRow = document.createElement("div");
            cropRow.style.cssText = "display: flex; gap: 4px; justify-content: space-between; flex-wrap: nowrap;";
            const cropPresetBtns = [];
            CROP_PRESETS.forEach(p => {
                const b = createBtn(p.label, false, `选中 ${p.label} 比例并进入裁剪模式，裁剪框可自由移动 / 缩放（锁定该比例）`);
                b.style.flex = "1";
                b.style.padding = "3px 2px";
                b.style.textAlign = "center";
                b.onclick = () => onCropPreset(p.r);
                cropPresetBtns.push(b);
                cropRow.appendChild(b);
            });
            layerCtrlSection.appendChild(cropRow);

            const cropRow2 = document.createElement("div");
            cropRow2.style.cssText = "display: flex; gap: 4px; margin-top: 2px;";

            const btnCropCustom = createBtn("⛶ 自定义裁剪", false, "自定义裁剪：在画板上拖拽裁剪框（内部拖动可移动，八向手柄可缩放，Shift 锁定比例，Esc 取消）");
            btnCropCustom.style.flex = "1";
            btnCropCustom.style.padding = "3px 3px";
            btnCropCustom.style.textAlign = "center";
            btnCropCustom.style.borderColor = "#0088aa";
            btnCropCustom.style.background = "#142d38";

            const btnCropApply = createBtn("✔ 应用裁剪", false, "应用当前裁剪框并退出裁剪模式 (Enter)");
            btnCropApply.style.flex = "1";
            btnCropApply.style.padding = "3px 3px";
            btnCropApply.style.textAlign = "center";
            btnCropApply.style.borderColor = "#1f7a3a";
            btnCropApply.style.background = "#12351d";

            const btnCropCancel = createBtn("✕ 取消", false, "放弃本次裁剪并退出裁剪模式 (Esc)");
            btnCropCancel.style.flex = "1";
            btnCropCancel.style.padding = "3px 3px";
            btnCropCancel.style.textAlign = "center";

            cropRow2.appendChild(btnCropCustom);
            cropRow2.appendChild(btnCropApply);
            cropRow2.appendChild(btnCropCancel);
            layerCtrlSection.appendChild(cropRow2);

            const updateCropUI = () => {
                const on = !!state.cropMode;
                btnCropCustom.textContent = on ? "⛶ 自由比例" : "⛶ 自定义裁剪";
                btnCropCustom.title = on
                    ? "解除比例锁定：裁剪框改为自由拖拽缩放"
                    : "自定义裁剪：进入画板自由框选裁剪区域（无比例限制）";
                btnCropApply.style.display = on ? "" : "none";
                btnCropCancel.style.display = on ? "" : "none";
                cropPresetBtns.forEach((b, i) => {
                    const locked = on && state.cropRatioLock === CROP_PRESETS[i].r;
                    b.style.background = locked ? "#0088aa" : "#2a2a2a";
                    b.style.borderColor = locked ? "#00e5ff" : "#444";
                });
            };

            const enterCropMode = () => {
                const layer = getCropTargetLayer();
                if (!layer) { alert("请先在画板上选中一个图片图层，再进行裁剪。"); return; }
                state.cropMode = true;
                state.cropLayerId = layer.id;
                state.cropRatioLock = null;
                state.cropRect = { x: 0, y: 0, w: layer.origW, h: layer.origH };
                state.cropAction = null;
                state.cropHandle = null;
                if (state.tool !== "select") {
                    state.prevTool = state.tool;
                    state.tool = "select";
                    updateBtns();
                }
                updateCropUI();
                requestScreenRender();
            };

            const exitCropMode = () => {
                if (!state.cropMode) return;
                state.cropMode = false;
                state.cropLayerId = null;
                state.cropRect = null;
                state.cropRatioLock = null;
                state.cropAction = null;
                state.cropHandle = null;
                state.cropInitRect = null;
                state.cropInitPointer = null;
                if (state.prevTool) {
                    state.tool = state.prevTool;
                    state.prevTool = null;
                    updateBtns();
                }
                updateCropUI();
                requestScreenRender();
            };

            const applyCropMode = () => {
                const layer = getCropTargetLayer();
                if (layer && state.cropRect) {
                    if (cropLayerToRect(layer, state.cropRect)) {
                        syncLayerPanelUI();
                        debouncedSave();
                    }
                }
                exitCropMode();
            };

            // 比例裁剪：只负责进入裁剪模式 + 框定该比例，区域由用户自行拖拽调整
            const onCropPreset = (r) => {
                let layer = getCropTargetLayer();
                if (!layer) { alert("请先在画板上选中一个图片图层，再进行裁剪。"); return; }
                if (!state.cropMode || state.cropLayerId !== layer.id) {
                    enterCropMode();
                    layer = getCropTargetLayer();
                    if (!layer) return;
                }
                state.cropRatioLock = r;
                state.cropRect = fitRatioInRect(layer.origW, layer.origH, r);
                updateCropUI();
                requestScreenRender();
            };

            btnCropCustom.onclick = () => {
                if (state.cropMode) {
                    // 已处于裁剪模式：仅解除比例锁定，裁剪框保持原样，改为自由拖拽
                    state.cropRatioLock = null;
                    updateCropUI();
                    requestScreenRender();
                } else {
                    enterCropMode();
                }
            };
            btnCropApply.onclick = () => applyCropMode();
            btnCropCancel.onclick = () => exitCropMode();
            updateCropUI();

            // 智能满铺排版模块
            const autoLayoutSection = document.createElement("div");
            autoLayoutSection.style.cssText = "display: flex; flex-direction: column; gap: 4px; border-top: 1px solid #333; padding-top: 6px;";
            
            const layoutTitle = document.createElement("span");
            layoutTitle.textContent = "📐 智能满铺排版 (4px间隙 · 零裁切 · 零拉伸):";
            layoutTitle.style.color = "#888";
            layoutTitle.style.fontSize = "10px";
            layoutTitle.title = "自动解算多图等比长宽比，四边顶死画板，绝无任何拉伸变形";
            autoLayoutSection.appendChild(layoutTitle);

            const layoutBtnRow = document.createElement("div");
            layoutBtnRow.style.cssText = "display: flex; gap: 4px; justify-content: space-between; flex-wrap: nowrap;";

            const btnHero = createBtn("📰 焦点", false, "焦点构图：将主图作为视觉核心置于主栏，副图自适应多维对齐，多次点击随机变换排列");
            const btnGrid = createBtn("田 网格", false, "网格构图：动态规划最优行流自适应排列，左右对齐满铺，多次点击随机探索不同布局");
            const btnRow = createBtn("━ 横排", false, "横排长卷：所有素材高度统一拉齐并水平横向排列，零裁切零拉伸");
            const btnCol = createBtn("┃ 竖排", false, "竖排长卷：所有素材宽度统一拉齐并垂直纵向排列，零裁切零拉伸");

            [btnHero, btnGrid, btnRow, btnCol].forEach(b => {
                b.style.flex = "1";
                b.style.padding = "3px 2px";
                b.style.textAlign = "center";
                layoutBtnRow.appendChild(b);
            });
            autoLayoutSection.appendChild(layoutBtnRow);

            // 对齐优化按钮
            const layoutBtnRow2 = document.createElement("div");
            layoutBtnRow2.style.cssText = "display: flex; gap: 4px; margin-top: 2px;";
            const btnTidy = createBtn("✨ 对齐优化 (保持粗排大格局)", false, "根据当前画板中的粗略手动摆放，保持大体纵向分栏/横向分行格局不动，精确对齐边缘、规整4px微缝并统一尺寸缩放，零裁切零变形");
            btnTidy.style.flex = "1";
            btnTidy.style.padding = "3px 4px";
            btnTidy.style.textAlign = "center";
            btnTidy.style.borderColor = "#0088aa";
            btnTidy.style.background = "#142d38";
            layoutBtnRow2.appendChild(btnTidy);
            autoLayoutSection.appendChild(layoutBtnRow2);

            layerCtrlSection.appendChild(autoLayoutSection);
            popover.appendChild(layerCtrlSection);

            // 面板内容超高时走滚动，禁止子项被压缩
            Array.from(popover.children).forEach(child => { child.style.flexShrink = "0"; });

            root.appendChild(popover);

            btnPanelToggle.onclick = () => {
                popover.style.display = popover.style.display === "none" ? "flex" : "none";
            };

            // 按钮状态联动
            const updateBtns = () => {
                btnBrush.style.background = (state.tool === "brush" || state.tool === "eraser") ? "#0066cc" : "#2a2a2a";
                btnSelect.style.background = state.tool === "select" ? "#aa6600" : "#2a2a2a";
                btnSubBrush.style.background = state.tool === "brush" ? "#0066cc" : "#2a2a2a";
                btnSubEraser.style.background = state.tool === "eraser" ? "#0066cc" : "#2a2a2a";
                btnSubLayerEraser.style.background = state.tool === "layer_eraser" ? "#008888" : "#2a2a2a";
                btnEyedropper.style.background = state.tool === "eyedropper" ? "#0066cc" : "#2a2a2a";
            };

            btnBrush.onclick = () => {
                state.tool = (state.tool === "brush") ? "select" : "brush";
                updateBtns();
                requestScreenRender();
            };

            btnSelect.onclick = () => { state.tool = "select"; updateBtns(); requestScreenRender(); };

            btnSubBrush.onclick = () => {
                state.tool = (state.tool === "brush") ? "select" : "brush";
                updateBtns();
                requestScreenRender();
            };

            btnSubEraser.onclick = () => {
                state.tool = (state.tool === "eraser") ? "select" : "eraser";
                updateBtns();
                requestScreenRender();
            };

            btnSubLayerEraser.onclick = () => {
                if (state.tool === "layer_eraser") {
                    state.tool = "select";
                } else {
                    if (state.selectedLayerIndex < 0 && state.layers.length > 0) {
                        state.selectedLayerIndex = state.layers.length - 1;
                        state.selectedLayerIndices = [state.selectedLayerIndex];
                    }
                    state.tool = "layer_eraser";
                }
                updateBtns();
                requestScreenRender();
            };

            btnEyedropper.onclick = () => {
                if (state.tool === "eyedropper") {
                    state.tool = "brush";
                } else {
                    state.tool = "eyedropper";
                    // 进入吸管取色时预先烘焙一次底图供实时取色读取，避免在 pointermove 时重复烘焙
                    bakeCompositeImage();
                    popover.style.display = "none";
                }
                updateBtns();
                requestScreenRender();
            };

            // 提取原生物理真实宽高比
            const getNativeAspect = (idx) => {
                const l = state.layers[idx];
                if (!l) return 1.0;
                if (l.canvas && l.canvas.width > 0 && l.canvas.height > 0) {
                    return l.canvas.width / l.canvas.height;
                }
                if (l.origW && l.origH && l.origW > 0 && l.origH > 0) {
                    return l.origW / l.origH;
                }
                return (l.w > 0 && l.h > 0) ? (l.w / l.h) : 1.0;
            };

            // 视口容器
            const viewport = document.createElement("div");
            viewport.style.cssText = `
                position: relative; flex: 1; width: 100%; min-height: 200px;
                background: #111; overflow: hidden; touch-action: none;
                border-bottom-left-radius: 6px; border-bottom-right-radius: 6px;
            `;

            const displayCanvas = document.createElement("canvas");
            displayCanvas.style.cssText = "position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block;";
            const displayCtx = displayCanvas.getContext("2d");
            viewport.appendChild(displayCanvas);

            // 画板底部尺寸标签
            const canvasDimBadge = document.createElement("div");
            canvasDimBadge.style.cssText = `
                position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
                background: rgba(16, 16, 16, 0.75); backdrop-filter: blur(4px); padding: 2px 8px;
                border-radius: 10px; font-size: 10px; color: #888; border: 1px solid #333;
                pointer-events: none; white-space: nowrap; z-index: 5;
            `;
            viewport.appendChild(canvasDimBadge);
            root.appendChild(viewport);

            const getPhysicalDimensions = () => {
                const base = BASE_RATIOS[state.ratio] || [768, 1024];
                const mult = MULTIPLIERS[state.scaleTier] || 2;
                return [base[0] * mult, base[1] * mult];
            };

            let [targetW, targetH] = getPhysicalDimensions();
            const drawCanvas = document.createElement("canvas");
            drawCanvas.width = targetW; drawCanvas.height = targetH;
            const drawCtx = drawCanvas.getContext("2d", { willReadFrequently: true });

            const exportCanvas = document.createElement("canvas");
            exportCanvas.width = targetW; exportCanvas.height = targetH;
            const expCtx = exportCanvas.getContext("2d", { willReadFrequently: true });

            const updateDimBadgeText = () => {
                const txt = `${targetW} × ${targetH} px (${state.scaleTier} · ${state.ratio})`;
                if (canvasDimBadge.textContent !== txt) {
                    canvasDimBadge.textContent = txt;
                }
            };

            const bakeCompositeImage = () => {
                expCtx.imageSmoothingEnabled = true;
                expCtx.imageSmoothingQuality = "high";
                expCtx.clearRect(0, 0, targetW, targetH);
                if (bgSelect.value === "white") {
                    expCtx.fillStyle = "#FFFFFF";
                    expCtx.fillRect(0, 0, targetW, targetH);
                } else if (bgSelect.value === "black") {
                    expCtx.fillStyle = "#000000";
                    expCtx.fillRect(0, 0, targetW, targetH);
                } else if (bgSelect.value === "gray") {
                    expCtx.fillStyle = "#808080";
                    expCtx.fillRect(0, 0, targetW, targetH);
                }

                state.layers.forEach(l => {
                    expCtx.save();
                    expCtx.globalAlpha = l.opacity !== undefined ? l.opacity : 1.0;
                    const cx = l.x + l.w / 2;
                    const cy = l.y + l.h / 2;
                    expCtx.translate(cx, cy);
                    if (l.rotation) expCtx.rotate((l.rotation * Math.PI) / 180);
                    expCtx.scale(l.flipH ? -1 : 1, 1);
                    expCtx.drawImage(l.canvas, -l.w / 2, -l.h / 2, l.w, l.h);
                    expCtx.restore();
                });

                expCtx.drawImage(drawCanvas, 0, 0);
            };

            const syncDisplayCanvasLayout = () => {
                const vw = viewport.clientWidth || 400;
                const vh = viewport.clientHeight || 400;
                const margin = 8;
                const availW = Math.max(50, vw - margin * 2);
                const availH = Math.max(50, vh - margin * 2);

                const scale = Math.min(availW / targetW, availH / targetH);
                const dispW = Math.round(targetW * scale);
                const dispH = Math.round(targetH * scale);
                const dispX = Math.round((vw - dispW) / 2);
                const dispY = Math.round((vh - dispH) / 2);

                if (displayCanvas.width !== targetW || displayCanvas.height !== targetH) {
                    displayCanvas.width = targetW;
                    displayCanvas.height = targetH;
                }

                // 仅在布局数值变化时才写入 DOM style，彻底避免每帧触发浏览器 Layout Thrashing
                if (
                    currentLayout.dispW !== dispW ||
                    currentLayout.dispH !== dispH ||
                    currentLayout.dispX !== dispX ||
                    currentLayout.dispY !== dispY
                ) {
                    displayCanvas.style.position = "absolute";
                    displayCanvas.style.left = `${dispX}px`;
                    displayCanvas.style.top = `${dispY}px`;
                    displayCanvas.style.width = `${dispW}px`;
                    displayCanvas.style.height = `${dispH}px`;
                }

                currentLayout = { dispW, dispH, dispX, dispY, scale };
                updateDimBadgeText();
                return currentLayout;
            };

            // 自由旋转手柄：位于选区顶边中点外侧；越界时自动内收，保证手柄始终可见可点
            const getRotateHandleWorldPos = (layer, hs) => {
                const cx = layer.x + layer.w / 2;
                const cy = layer.y + layer.h / 2;
                const rad = ((layer.rotation || 0) * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const ratio = targetW / Math.max(1, currentLayout.dispW);
                const offset = Math.max(16, hs + 14 * ratio);
                const localX = 0;
                const localY = -layer.h / 2 - offset;
                let gx = cx + (localX * cos - localY * sin);
                let gy = cy + (localX * sin + localY * cos);
                const m = hs;
                gx = Math.min(Math.max(gx, m), targetW - m);
                gy = Math.min(Math.max(gy, m), targetH - m);
                return { x: gx, y: gy };
            };

            const renderScreen = () => {
                if (displayCanvas.width !== targetW || displayCanvas.height !== targetH || !currentLayout.dispW) {
                    syncDisplayCanvasLayout();
                }
                const ratio = targetW / Math.max(1, currentLayout.dispW);

                displayCtx.imageSmoothingEnabled = true;
                // 交互拖拽/绘画期间使用 medium 插值大幅降低 2K/4K/8K 实时重绘帧耗时，静止时恢复 high 最高画质
                displayCtx.imageSmoothingQuality = state.isInteracting ? "medium" : "high";
                displayCtx.clearRect(0, 0, targetW, targetH);

                if (bgSelect.value === "white") {
                    displayCtx.fillStyle = "#FFFFFF";
                    displayCtx.fillRect(0, 0, targetW, targetH);
                } else if (bgSelect.value === "black") {
                    displayCtx.fillStyle = "#000000";
                    displayCtx.fillRect(0, 0, targetW, targetH);
                } else if (bgSelect.value === "gray") {
                    displayCtx.fillStyle = "#808080";
                    displayCtx.fillRect(0, 0, targetW, targetH);
                }

                state.layers.forEach(l => {
                    displayCtx.save();
                    displayCtx.globalAlpha = l.opacity !== undefined ? l.opacity : 1.0;
                    const cx = l.x + l.w / 2;
                    const cy = l.y + l.h / 2;
                    displayCtx.translate(cx, cy);
                    if (l.rotation) displayCtx.rotate((l.rotation * Math.PI) / 180);
                    displayCtx.scale(l.flipH ? -1 : 1, 1);
                    displayCtx.drawImage(l.canvas, -l.w / 2, -l.h / 2, l.w, l.h);
                    displayCtx.restore();
                });

                displayCtx.drawImage(drawCanvas, 0, 0);

                // 物理安全框
                displayCtx.strokeStyle = "rgba(0, 229, 255, 0.6)";
                displayCtx.lineWidth = Math.max(1.0, 1.0 * ratio);
                displayCtx.setLineDash([6 * ratio, 4 * ratio]);
                displayCtx.strokeRect(0, 0, targetW, targetH);
                displayCtx.setLineDash([]);

                // 选框与四角防裁切控制手柄
                const activeIndices = state.selectedLayerIndices.length > 0 ? state.selectedLayerIndices : (state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : []);
                activeIndices.forEach(idx => {
                    const sel = state.layers[idx];
                    if (!sel) return;

                    displayCtx.save();
                    const cx = sel.x + sel.w / 2;
                    const cy = sel.y + sel.h / 2;
                    displayCtx.translate(cx, cy);
                    if (sel.rotation) displayCtx.rotate((sel.rotation * Math.PI) / 180);

                    displayCtx.strokeStyle = (state.tool === "layer_eraser") ? "#ff00bb" : "#00e5ff";
                    displayCtx.lineWidth = Math.max(1.0, 1.0 * ratio);
                    displayCtx.strokeRect(-sel.w / 2, -sel.h / 2, sel.w, sel.h);

                    const dimText = `${Math.round(sel.w)} × ${Math.round(sel.h)}`;
                    displayCtx.font = `bold ${8 * ratio}px sans-serif`;
                    displayCtx.fillStyle = "#00e5ff";
                    displayCtx.textAlign = "center";
                    displayCtx.textBaseline = "top";
                    displayCtx.fillText(dimText, 0, sel.h / 2 + 4 * ratio);

                    if (state.tool === "select" && idx === state.selectedLayerIndex && !state.cropMode) {
                        const hs = Math.max(12, Math.min(24, 8 * ratio));
                        
                        const drawCornerHandle = (localX, localY) => {
                            const rad = ((sel.rotation || 0) * Math.PI) / 180;
                            const cos = Math.cos(rad);
                            const sin = Math.sin(rad);

                            // 计算手柄的物理世界绝对坐标
                            const globalX = cx + (localX * cos - localY * sin);
                            const globalY = cy + (localX * sin + localY * cos);

                            let drawGX = globalX;
                            let drawGY = globalY;
                            if (drawGX - hs / 2 < 0) drawGX = hs / 2;
                            if (drawGX + hs / 2 > targetW) drawGX = targetW - hs / 2;
                            if (drawGY - hs / 2 < 0) drawGY = hs / 2;
                            if (drawGY + hs / 2 > targetH) drawGY = targetH - hs / 2;

                            // 变换回当前旋转上下文的绘制坐标，确保贴合手柄且边缘不裁切
                            const dGX = drawGX - cx;
                            const dGY = drawGY - cy;
                            const lx = dGX * cos + dGY * sin;
                            const ly = -dGX * sin + dGY * cos;

                            displayCtx.save();
                            displayCtx.fillStyle = "#00e5ff";
                            displayCtx.fillRect(lx - hs / 2, ly - hs / 2, hs, hs);
                            displayCtx.strokeStyle = "#ffffff";
                            displayCtx.lineWidth = Math.max(1.0, 1.5 * ratio);
                            displayCtx.strokeRect(lx - hs / 2, ly - hs / 2, hs, hs);
                            displayCtx.restore();
                        };

                        drawCornerHandle(-sel.w / 2, -sel.h / 2); // tl
                        drawCornerHandle(sel.w / 2, -sel.h / 2);  // tr
                        drawCornerHandle(-sel.w / 2, sel.h / 2);  // bl
                        drawCornerHandle(sel.w / 2, sel.h / 2);   // br

                        const delRadius = Math.max(7, 6.5 * ratio);
                        const offset = hs + 10 * ratio;
                        const delCenterX = sel.w / 2 - offset;
                        const delCenterY = -sel.h / 2 + offset;

                        displayCtx.beginPath();
                        displayCtx.arc(delCenterX, delCenterY, delRadius, 0, Math.PI * 2);
                        displayCtx.fillStyle = "#ff3333";
                        displayCtx.fill();
                        displayCtx.strokeStyle = "#ffffff";
                        displayCtx.lineWidth = 1.0 * ratio;
                        displayCtx.stroke();

                        displayCtx.fillStyle = "#ffffff";
                        displayCtx.font = `bold ${8 * ratio}px sans-serif`;
                        displayCtx.textAlign = "center";
                        displayCtx.textBaseline = "middle";
                        displayCtx.fillText("✕", delCenterX, delCenterY);

                        // 自由旋转手柄：拖拽即可任意角度旋转，按住 Shift 吸附 15° 整数倍
                        const rotHandle = getRotateHandleWorldPos(sel, hs);
                        const rdx = rotHandle.x - cx;
                        const rdy = rotHandle.y - cy;
                        const rcos = Math.cos(((sel.rotation || 0) * Math.PI) / 180);
                        const rsin = Math.sin(((sel.rotation || 0) * Math.PI) / 180);
                        const rhx = rdx * rcos + rdy * rsin;
                        const rhy = -rdx * rsin + rdy * rcos;

                        displayCtx.beginPath();
                        displayCtx.moveTo(0, -sel.h / 2);
                        displayCtx.lineTo(rhx, rhy);
                        displayCtx.strokeStyle = "#00e5ff";
                        displayCtx.lineWidth = Math.max(1.0, 1.5 * ratio);
                        displayCtx.stroke();

                        const rhr = Math.max(6, 6 * ratio);
                        displayCtx.beginPath();
                        displayCtx.arc(rhx, rhy, rhr, 0, Math.PI * 2);
                        displayCtx.fillStyle = "#00e5ff";
                        displayCtx.fill();
                        displayCtx.strokeStyle = "#ffffff";
                        displayCtx.lineWidth = Math.max(1.0, 1.5 * ratio);
                        displayCtx.stroke();

                        displayCtx.fillStyle = "#062028";
                        displayCtx.font = `bold ${9 * ratio}px sans-serif`;
                        displayCtx.textAlign = "center";
                        displayCtx.textBaseline = "middle";
                        displayCtx.fillText("↻", rhx, rhy);
                    }

                    // 自定义裁剪：框外遮罩 + 裁剪框 + 三分线 + 八向手柄
                    if (state.cropMode && idx === state.selectedLayerIndex && state.cropRect && sel.id === state.cropLayerId) {
                        const fx = sel.flipH ? -1 : 1;
                        const db = cropRectToDrawBox(sel, state.cropRect);
                        const hs = Math.max(10, Math.min(20, 7 * ratio));
                        const boxL = -sel.w / 2, boxT = -sel.h / 2;
                        const boxR = sel.w / 2, boxB = sel.h / 2;

                        displayCtx.save();
                        displayCtx.scale(fx, 1);

                        displayCtx.fillStyle = "rgba(0, 0, 0, 0.62)";
                        displayCtx.fillRect(boxL, boxT, boxR - boxL, Math.max(0, db.y - boxT));
                        displayCtx.fillRect(boxL, db.y + db.h, boxR - boxL, Math.max(0, boxB - (db.y + db.h)));
                        displayCtx.fillRect(boxL, db.y, Math.max(0, db.x - boxL), db.h);
                        displayCtx.fillRect(db.x + db.w, db.y, Math.max(0, boxR - (db.x + db.w)), db.h);

                        displayCtx.strokeStyle = "#00e5ff";
                        displayCtx.lineWidth = Math.max(1.0, 1.6 * ratio);
                        displayCtx.strokeRect(db.x, db.y, db.w, db.h);

                        displayCtx.strokeStyle = "rgba(255, 255, 255, 0.35)";
                        displayCtx.lineWidth = Math.max(1.0, 1.0 * ratio);
                        displayCtx.beginPath();
                        for (let i = 1; i <= 2; i++) {
                            const gx = db.x + (db.w * i) / 3;
                            const gy = db.y + (db.h * i) / 3;
                            displayCtx.moveTo(gx, db.y);
                            displayCtx.lineTo(gx, db.y + db.h);
                            displayCtx.moveTo(db.x, gy);
                            displayCtx.lineTo(db.x + db.w, gy);
                        }
                        displayCtx.stroke();

                        const hpts = [
                            [db.x, db.y], [db.x + db.w / 2, db.y], [db.x + db.w, db.y],
                            [db.x, db.y + db.h / 2], [db.x + db.w, db.y + db.h / 2],
                            [db.x, db.y + db.h], [db.x + db.w / 2, db.y + db.h], [db.x + db.w, db.h + db.y]
                        ];
                        displayCtx.fillStyle = "#00e5ff";
                        displayCtx.strokeStyle = "#ffffff";
                        displayCtx.lineWidth = Math.max(1.0, 1.2 * ratio);
                        hpts.forEach(pt => {
                            displayCtx.fillRect(pt[0] - hs / 2, pt[1] - hs / 2, hs, hs);
                            displayCtx.strokeRect(pt[0] - hs / 2, pt[1] - hs / 2, hs, hs);
                        });

                        displayCtx.fillStyle = "#00e5ff";
                        displayCtx.font = `bold ${8 * ratio}px sans-serif`;
                        displayCtx.textAlign = "center";
                        displayCtx.textBaseline = "bottom";
                        displayCtx.fillText(`${Math.round(state.cropRect.w)} × ${Math.round(state.cropRect.h)}`,
                            db.x + db.w / 2, db.y - 5 * ratio);

                        displayCtx.restore();
                    }
                    displayCtx.restore();
                });

                if (state.actionType === "box_select" && state.boxSelectRect) {
                    const { x, y, w, h } = state.boxSelectRect;
                    const rx = w < 0 ? x + w : x;
                    const ry = h < 0 ? y + h : y;
                    const rw = Math.abs(w);
                    const rh = Math.abs(h);

                    displayCtx.save();
                    displayCtx.fillStyle = "rgba(0, 229, 255, 0.15)";
                    displayCtx.fillRect(rx, ry, rw, rh);
                    displayCtx.strokeStyle = "#00e5ff";
                    displayCtx.lineWidth = 1.0 * ratio;
                    displayCtx.setLineDash([4 * ratio, 4 * ratio]);
                    displayCtx.strokeRect(rx, ry, rw, rh);
                    displayCtx.restore();
                }

                if (state.mousePos.x >= 0 && state.mousePos.x <= targetW && state.mousePos.y >= 0 && state.mousePos.y <= targetH) {
                    if (state.tool === "eyedropper") {
                        const px = Math.min(targetW - 1, Math.max(0, Math.floor(state.mousePos.x)));
                        const py = Math.min(targetH - 1, Math.max(0, Math.floor(state.mousePos.y)));
                        const pData = expCtx.getImageData(px, py, 1, 1).data;
                        const curHex = `#${((1 << 24) + (pData[0] << 16) + (pData[1] << 8) + pData[2]).toString(16).slice(1).toUpperCase()}`;

                        displayCtx.save();
                        displayCtx.strokeStyle = "#ff2222";
                        displayCtx.lineWidth = 1.5 * ratio;
                        displayCtx.beginPath();
                        displayCtx.arc(state.mousePos.x, state.mousePos.y, 4 * ratio, 0, Math.PI * 2);
                        displayCtx.stroke();
                        displayCtx.beginPath();
                        displayCtx.moveTo(state.mousePos.x - 9 * ratio, state.mousePos.y);
                        displayCtx.lineTo(state.mousePos.x + 9 * ratio, state.mousePos.y);
                        displayCtx.moveTo(state.mousePos.x, state.mousePos.y - 9 * ratio);
                        displayCtx.lineTo(state.mousePos.x, state.mousePos.y + 9 * ratio);
                        displayCtx.stroke();

                        const ringX = state.mousePos.x + 18 * ratio;
                        const ringY = state.mousePos.y - 18 * ratio;
                        displayCtx.beginPath();
                        displayCtx.arc(ringX, ringY, 12 * ratio, 0, Math.PI * 2);
                        displayCtx.fillStyle = `rgb(${pData[0]}, ${pData[1]}, ${pData[2]})`;
                        displayCtx.fill();
                        displayCtx.strokeStyle = "#ffffff";
                        displayCtx.lineWidth = 2.5 * ratio;
                        displayCtx.stroke();

                        displayCtx.font = `bold ${10 * ratio}px sans-serif`;
                        const tw = displayCtx.measureText(curHex).width;
                        displayCtx.fillStyle = "rgba(0, 0, 0, 0.8)";
                        displayCtx.fillRect(ringX + 16 * ratio, ringY - 8 * ratio, tw + 6 * ratio, 16 * ratio);
                        displayCtx.fillStyle = "#ffffff";
                        displayCtx.fillText(curHex, ringX + 19 * ratio, ringY + 4 * ratio);
                        displayCtx.restore();
                    } else if (state.tool === "brush" || state.tool === "eraser" || state.tool === "layer_eraser") {
                        const activeSize = state.tool === "layer_eraser" ? state.layerEraserSize : state.brushSize;
                        const curRadius = activeSize / 2;

                        displayCtx.save();
                        displayCtx.beginPath();
                        displayCtx.arc(state.mousePos.x, state.mousePos.y, Math.max(2, curRadius), 0, Math.PI * 2);
                        displayCtx.strokeStyle = "#ff2222";
                        displayCtx.lineWidth = Math.max(1.5, 1.5 * ratio);
                        displayCtx.stroke();

                        displayCtx.beginPath();
                        displayCtx.moveTo(state.mousePos.x - 6 * ratio, state.mousePos.y);
                        displayCtx.lineTo(state.mousePos.x + 6 * ratio, state.mousePos.y);
                        displayCtx.moveTo(state.mousePos.x, state.mousePos.y - 6 * ratio);
                        displayCtx.lineTo(state.mousePos.x, state.mousePos.y + 6 * ratio);
                        displayCtx.strokeStyle = "#ff2222";
                        displayCtx.lineWidth = Math.max(1.2, 1.2 * ratio);
                        displayCtx.stroke();
                        displayCtx.restore();
                    }
                }
            };

            const requestScreenRender = () => {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    renderScreen();
                });
            };

            // 核心算法引擎：纯代数零拉伸求解 + 焦点/网格多样性 + 拓扑对齐优化
            const executeAutoLayout = (mode) => {
                const targetIndices = (state.selectedLayerIndices.length > 1)
                    ? [...state.selectedLayerIndices]
                    : state.layers.map((_, i) => i);

                const N = targetIndices.length;
                if (N === 0) return;

                pushLayerSnapshot();

                const GAP = 4; // 严格保持 4px 黄金微缝隙

                if (mode === "hero") {
                    if (N === 1) {
                        const idx = targetIndices[0];
                        const l = state.layers[idx];
                        const r = getNativeAspect(idx);
                        let w = targetW;
                        let h = w / r;
                        if (h > targetH) { h = targetH; w = h * r; }
                        l.w = w; l.h = h;
                        l.x = (targetW - w) / 2;
                        l.y = (targetH - h) / 2;
                    } else {
                        let heroIdx = targetIndices[0];
                        let maxArea = -1;
                        targetIndices.forEach(idx => {
                            const l = state.layers[idx];
                            const area = (l.w || 100) * (l.h || 100);
                            if (area > maxArea) {
                                maxArea = area;
                                heroIdx = idx;
                            }
                        });
                        if (state.selectedLayerIndex >= 0 && targetIndices.includes(state.selectedLayerIndex)) {
                            heroIdx = state.selectedLayerIndex;
                        }

                        const hl = state.layers[heroIdx];
                        const rHero = getNativeAspect(heroIdx);
                        
                        // 锁定主图视觉焦点，副图随机乱序重排，探索更多排版可能
                        const subIndices = targetIndices.filter(i => i !== heroIdx);
                        for (let i = subIndices.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [subIndices[i], subIndices[j]] = [subIndices[j], subIndices[i]];
                        }
                        const M = subIndices.length;

                        const isWide = targetW >= targetH;

                        if (isWide) {
                            let bestPlan = null;
                            let maxCoverage = -Infinity;

                            const maxPossibleCols = Math.min(M, (targetW > targetH * 1.5) ? 3 : 2);
                            const candidateColCounts = [];
                            for (let c = 1; c <= maxPossibleCols; c++) candidateColCounts.push(c);

                            candidateColCounts.forEach(numCols => {
                                const cols = [];
                                for (let c = 0; c < numCols; c++) cols.push([]);
                                subIndices.forEach((idx, i) => cols[i % numCols].push(idx));

                                const colKs = cols.map(cList => {
                                    return cList.reduce((acc, idx) => acc + (1.0 / getNativeAspect(idx)), 0);
                                });

                                const sumInvK = colKs.reduce((acc, K) => acc + (1.0 / Math.max(0.01, K)), 0);
                                const gapCorrection = GAP + (numCols - 1) * GAP - cols.reduce((acc, cList, cIdx) => {
                                    return acc + ((cList.length - 1) * GAP) / Math.max(0.01, colKs[cIdx]);
                                }, 0);

                                const H_req = (targetW - gapCorrection) / (rHero + sumInvK);
                                const scaleH = Math.min(1.0, targetH / H_req);
                                const H_actual = H_req * scaleH;

                                const wHero = H_actual * rHero;
                                const colWidths = cols.map((cList, cIdx) => {
                                    const availColH = H_actual - (cList.length - 1) * GAP;
                                    return availColH / Math.max(0.01, colKs[cIdx]);
                                });
                                const totalW = wHero + GAP + colWidths.reduce((a, b) => a + b, 0) + (numCols - 1) * GAP;
                                const coverage = totalW * H_actual;

                                if (coverage > maxCoverage) {
                                    maxCoverage = coverage;
                                    bestPlan = { numCols, cols, colKs, H_actual, wHero, colWidths, totalW };
                                }
                            });

                            if (bestPlan) {
                                const { numCols, cols, colKs, H_actual, wHero, colWidths, totalW } = bestPlan;
                                const startX = Math.max(0, (targetW - totalW) / 2);
                                const startY = Math.max(0, (targetH - H_actual) / 2);

                                const heroOnRight = hl.x > targetW / 2;
                                const heroX = heroOnRight ? (startX + (totalW - wHero)) : startX;
                                const subAreaX = heroOnRight ? startX : (startX + wHero + GAP);

                                hl.w = wHero;
                                hl.h = H_actual;
                                hl.x = heroX;
                                hl.y = startY;

                                let curColX = subAreaX;
                                cols.forEach((cList, cIdx) => {
                                    const wCol = colWidths[cIdx];
                                    let curY = startY;
                                    cList.forEach(idx => {
                                        const l = state.layers[idx];
                                        const r = getNativeAspect(idx);
                                        const hItem = wCol / r;
                                        l.w = wCol;
                                        l.h = hItem;
                                        l.x = curColX;
                                        l.y = curY;
                                        curY += hItem + GAP;
                                    });
                                    curColX += wCol + GAP;
                                });
                            }
                        } else {
                            let bestPlan = null;
                            let maxCoverage = -Infinity;

                            const maxPossibleRows = Math.min(M, (targetH > targetW * 1.5) ? 3 : 2);
                            const candidateRowCounts = [];
                            for (let r = 1; r <= maxPossibleRows; r++) candidateRowCounts.push(r);

                            candidateRowCounts.forEach(numRows => {
                                const rows = [];
                                for (let r = 0; r < numRows; r++) rows.push([]);
                                subIndices.forEach((idx, i) => rows[i % numRows].push(idx));

                                const rowSs = rows.map(rList => {
                                    return rList.reduce((acc, idx) => acc + getNativeAspect(idx), 0);
                                });

                                const sumInvS = rowSs.reduce((acc, S) => acc + (1.0 / Math.max(0.01, S)), 0);
                                const gapCorrection = GAP + (numRows - 1) * GAP - rows.reduce((acc, rList, rIdx) => {
                                    return acc + ((rList.length - 1) * GAP) / Math.max(0.01, rowSs[rIdx]);
                                }, 0);

                                const W_req = (targetH - gapCorrection) / (1.0 / rHero + sumInvS);
                                const scaleW = Math.min(1.0, targetW / W_req);
                                const W_actual = W_req * scaleW;

                                const hHero = W_actual / rHero;
                                const rowHeights = rows.map((rList, rIdx) => {
                                    const availRowW = W_actual - (rList.length - 1) * GAP;
                                    return availRowW / Math.max(0.01, rowSs[rIdx]);
                                });
                                const totalH = hHero + GAP + rowHeights.reduce((a, b) => a + b, 0) + (numRows - 1) * GAP;
                                const coverage = W_actual * totalH;

                                if (coverage > maxCoverage) {
                                    maxCoverage = coverage;
                                    bestPlan = { numRows, rows, rowSs, W_actual, hHero, rowHeights, totalH };
                                }
                            });

                            if (bestPlan) {
                                const { numRows, rows, rowSs, W_actual, hHero, rowHeights, totalH } = bestPlan;
                                const startX = Math.max(0, (targetW - W_actual) / 2);
                                const startY = Math.max(0, (targetH - totalH) / 2);

                                const heroOnBottom = hl.y > targetH / 2;
                                const heroY = heroOnBottom ? (startY + (totalH - hHero)) : startY;
                                const subAreaY = heroOnBottom ? startY : (startY + hHero + GAP);

                                hl.w = W_actual;
                                hl.h = hHero;
                                hl.x = startX;
                                hl.y = heroY;

                                let curRowY = subAreaY;
                                rows.forEach((rList, rIdx) => {
                                    const hRow = rowHeights[rIdx];
                                    let curX = startX;
                                    rList.forEach(idx => {
                                        const l = state.layers[idx];
                                        const r = getNativeAspect(idx);
                                        const wItem = hRow * r;
                                        l.w = wItem;
                                        l.h = hRow;
                                        l.x = curX;
                                        l.y = curRowY;
                                        curX += wItem + GAP;
                                    });
                                    curRowY += hRow + GAP;
                                });
                            }
                        }
                    }
                } else if (mode === "grid") {
                    let sorted = [];
                    if (state.selectedLayerIndex >= 0 && targetIndices.includes(state.selectedLayerIndex)) {
                        const heroIdx = state.selectedLayerIndex;
                        const others = targetIndices.filter(i => i !== heroIdx);
                        for (let i = others.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [others[i], others[j]] = [others[j], others[i]];
                        }
                        sorted = [heroIdx, ...others];
                    } else {
                        sorted = [...targetIndices];
                        for (let i = sorted.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
                        }
                    }

                    if (N <= 2) {
                        executeAutoLayout(targetW >= targetH ? "row" : "col");
                        return;
                    }

                    const candidatePartitions = [];
                    if (N === 3) {
                        candidatePartitions.push([2, 1], [1, 2]);
                        if (targetW > targetH * 1.5) candidatePartitions.push([3]);
                    } else if (N === 4) {
                        candidatePartitions.push([2, 2]);
                        if (targetW > targetH * 1.6) candidatePartitions.push([4]);
                        if (targetH > targetW * 1.6) candidatePartitions.push([1, 2, 1]);
                    } else if (N === 5) {
                        if (targetW >= targetH) {
                            candidatePartitions.push([3, 2], [2, 3]);
                        } else {
                            candidatePartitions.push([2, 1, 2], [1, 2, 2], [2, 2, 1]);
                        }
                    } else if (N === 6) {
                        candidatePartitions.push([3, 3]);
                        if (targetH >= targetW) candidatePartitions.push([2, 2, 2]);
                    } else if (N === 7) {
                        candidatePartitions.push([4, 3], [3, 4], [2, 3, 2]);
                    } else if (N === 8) {
                        candidatePartitions.push([4, 4], [3, 2, 3]);
                    } else {
                        const c = Math.max(1, Math.round(Math.sqrt(N * (targetW / targetH))));
                        const r = Math.max(1, Math.ceil(N / c));
                        const p = [];
                        let remain = N;
                        while (remain > 0) {
                            const take = Math.min(remain, Math.ceil(remain / (r - p.length)));
                            p.push(take);
                            remain -= take;
                        }
                        candidatePartitions.push(p);
                    }

                    let bestPlan = null;
                    let bestScore = -Infinity;

                    candidatePartitions.forEach(p => {
                        let offset = 0;
                        const chunks = p.map(cnt => {
                            const c = sorted.slice(offset, offset + cnt);
                            offset += cnt;
                            return c;
                        });

                        const rowAspectSums = chunks.map(cList => {
                            return cList.reduce((acc, idx) => acc + getNativeAspect(idx), 0);
                        });

                        const sumInvS = rowAspectSums.reduce((acc, S) => acc + (1.0 / Math.max(0.01, S)), 0);
                        const gapCorrection = (chunks.length - 1) * GAP - chunks.reduce((acc, cList, i) => {
                            return acc + ((cList.length - 1) * GAP) / Math.max(0.01, rowAspectSums[i]);
                        }, 0);

                        const W_req = (targetH - gapCorrection) / Math.max(0.01, sumInvS);
                        let W_grid, H_total;
                        if (W_req <= targetW) {
                            W_grid = W_req;
                            H_total = targetH;
                        } else {
                            W_grid = targetW;
                            H_total = targetW * sumInvS + gapCorrection;
                        }

                        const scale = Math.min(1.0, targetH / H_total);
                        const rowHeights = chunks.map((cList, i) => {
                            return ((W_grid - (cList.length - 1) * GAP) / Math.max(0.01, rowAspectSums[i])) * scale;
                        });

                        const score = W_grid * (H_total * scale);
                        if (score > bestScore) {
                            bestScore = score;
                            bestPlan = { chunks, rowHeights, W_grid: W_grid * scale, H_total: H_total * scale };
                        }
                    });

                    if (bestPlan) {
                        const { chunks, rowHeights, W_grid, H_total } = bestPlan;
                        const startX = Math.max(0, (targetW - W_grid) / 2);
                        const startY = Math.max(0, (targetH - H_total) / 2);

                        let curY = startY;
                        chunks.forEach((cList, i) => {
                            const hRow = rowHeights[i];
                            let curX = startX;
                            cList.forEach(idx => {
                                const l = state.layers[idx];
                                const r = getNativeAspect(idx);
                                const wItem = hRow * r;
                                l.w = wItem;
                                l.h = hRow;
                                l.x = curX;
                                l.y = curY;
                                curX += wItem + GAP;
                            });
                            curY += hRow + GAP;
                        });
                    }
                } else if (mode === "row") {
                    const sorted = [...targetIndices].sort((a, b) => state.layers[a].x - state.layers[b].x);
                    const sumAspect = sorted.reduce((acc, idx) => acc + getNativeAspect(idx), 0);

                    const wAvail = targetW - (N - 1) * GAP;
                    const hIdeal = wAvail / Math.max(0.01, sumAspect);
                    let H = Math.min(targetH, hIdeal);
                    let totalW = H * sumAspect + (N - 1) * GAP;

                    const startX = Math.max(0, (targetW - totalW) / 2);
                    const startY = Math.max(0, (targetH - H) / 2);

                    let curX = startX;
                    sorted.forEach(idx => {
                        const l = state.layers[idx];
                        const r = getNativeAspect(idx);
                        const wItem = H * r;
                        l.w = wItem;
                        l.h = H;
                        l.x = curX;
                        l.y = startY;
                        curX += wItem + GAP;
                    });
                } else if (mode === "col") {
                    const sorted = [...targetIndices].sort((a, b) => state.layers[a].y - state.layers[b].y);
                    const sumInvAspect = sorted.reduce((acc, idx) => acc + (1.0 / getNativeAspect(idx)), 0);

                    const hAvail = targetH - (N - 1) * GAP;
                    const wIdeal = hAvail / Math.max(0.01, sumInvAspect);
                    let W = Math.min(targetW, wIdeal);
                    let totalH = W * sumInvAspect + (N - 1) * GAP;

                    const startX = Math.max(0, (targetW - W) / 2);
                    const startY = Math.max(0, (targetH - totalH) / 2);

                    let curY = startY;
                    sorted.forEach(idx => {
                        const l = state.layers[idx];
                        const r = getNativeAspect(idx);
                        const hItem = W / r;
                        l.w = W;
                        l.h = hItem;
                        l.x = startX;
                        l.y = curY;
                        curY += hItem + GAP;
                    });
                } else if (mode === "tidy") {
                    // 对齐优化模式：基于用户粗排空间拓扑进行边距、对齐与等比尺寸规整（严格保持大格局不动）
                    if (N === 1) {
                        const idx = targetIndices[0];
                        const l = state.layers[idx];
                        const r = getNativeAspect(idx);
                        let w = targetW;
                        let h = w / r;
                        if (h > targetH) { h = targetH; w = h * r; }
                        l.w = w; l.h = h;
                        l.x = (targetW - w) / 2;
                        l.y = (targetH - h) / 2;
                        requestScreenRender();
                        debouncedSave();
                        return;
                    }

                    const getOverlap = (min1, max1, min2, max2) => Math.max(0, Math.min(max1, max2) - Math.max(min1, min2));

                    // 1. 尝试构建纵向分栏拓扑 (Column Partition)
                    const sortedByX = [...targetIndices].sort((a, b) => {
                        const la = state.layers[a];
                        const lb = state.layers[b];
                        return (la.x + la.w / 2) - (lb.x + lb.w / 2);
                    });

                    const cols = [];
                    sortedByX.forEach(idx => {
                        const l = state.layers[idx];
                        const cx = l.x + l.w / 2;
                        let targetCol = null;

                        for (const col of cols) {
                            const colAvgCX = col.reduce((sum, i) => sum + (state.layers[i].x + state.layers[i].w / 2), 0) / col.length;
                            const colMaxW = col.reduce((max, i) => Math.max(max, state.layers[i].w), 0);
                            
                            // 若在纵向 Y 轴上与本列中已有图片出现大面积重叠（说明是左右并排关系），则坚决不能合并进同一列
                            const hasYConflict = col.some(i => {
                                const other = state.layers[i];
                                const ov = getOverlap(l.y, l.y + l.h, other.y, other.y + other.h);
                                return ov > 0.35 * Math.min(l.h, other.h);
                            });

                            if (!hasYConflict && Math.abs(cx - colAvgCX) < Math.max(targetW * 0.16, colMaxW * 0.75)) {
                                targetCol = col;
                                break;
                            }
                        }

                        if (targetCol) {
                            targetCol.push(idx);
                        } else {
                            cols.push([idx]);
                        }
                    });

                    // 对每列内部的图片按 Y 坐标自上而下排序
                    cols.forEach(cList => {
                        cList.sort((a, b) => (state.layers[a].y + state.layers[a].h / 2) - (state.layers[b].y + state.layers[b].h / 2));
                    });

                    // 2. 尝试构建横向分行拓扑 (Row Partition)
                    const sortedByY = [...targetIndices].sort((a, b) => {
                        const la = state.layers[a];
                        const lb = state.layers[b];
                        return (la.y + la.h / 2) - (lb.y + lb.h / 2);
                    });

                    const rows = [];
                    sortedByY.forEach(idx => {
                        const l = state.layers[idx];
                        const cy = l.y + l.h / 2;
                        let targetRow = null;

                        for (const row of rows) {
                            const rowAvgCY = row.reduce((sum, i) => sum + (state.layers[i].y + state.layers[i].h / 2), 0) / row.length;
                            const rowMaxH = row.reduce((max, i) => Math.max(max, state.layers[i].h), 0);

                            // 若在横向 X 轴上与本行中已有图片出现大面积重叠（说明是上下叠放关系），坚决不能合并进同一行
                            const hasXConflict = row.some(i => {
                                const other = state.layers[i];
                                const ov = getOverlap(l.x, l.x + l.w, other.x, other.x + other.w);
                                return ov > 0.35 * Math.min(l.w, other.w);
                            });

                            if (!hasXConflict && Math.abs(cy - rowAvgCY) < Math.max(targetH * 0.16, rowMaxH * 0.75)) {
                                targetRow = row;
                                break;
                            }
                        }

                        if (targetRow) {
                            targetRow.push(idx);
                        } else {
                            rows.push([idx]);
                        }
                    });

                    // 对每行内部图片按 X 坐标从左到右排序
                    rows.forEach(rList => {
                        rList.sort((a, b) => (state.layers[a].x + state.layers[a].w / 2) - (state.layers[b].x + state.layers[b].w / 2));
                    });

                    // 3. 智能模式判定：若存在贯通性高的大图或分栏特征明显，采用纵向分栏优先
                    const hasTallDominant = targetIndices.some(i => state.layers[i].h > targetH * 0.65);
                    const isColPreferred = hasTallDominant || (cols.length <= rows.length);

                    if (isColPreferred && cols.length >= 1) {
                        // 纵向分栏代数求解：所有列高度统一拉平为 H_opt，同列图片统一拉平为列宽，四边顶满画板
                        const colKs = cols.map(cList => {
                            return cList.reduce((acc, idx) => acc + (1.0 / getNativeAspect(idx)), 0);
                        });
                        const sumInvK_col = colKs.reduce((acc, K) => acc + (1.0 / Math.max(0.01, K)), 0);
                        const gapCorr_col = (cols.length - 1) * GAP - cols.reduce((acc, cList, cIdx) => {
                            return acc + ((cList.length - 1) * GAP) / Math.max(0.01, colKs[cIdx]);
                        }, 0);

                        let H_req = (targetW - gapCorr_col) / Math.max(0.01, sumInvK_col);
                        let H_opt = Math.min(targetH, H_req);
                        let totalW = H_opt * sumInvK_col + gapCorr_col;

                        if (H_opt < targetH && (targetH * sumInvK_col + gapCorr_col) <= targetW) {
                            H_opt = targetH;
                            totalW = targetH * sumInvK_col + gapCorr_col;
                        }

                        const colWidths = cols.map((cList, cIdx) => {
                            const availColH = H_opt - (cList.length - 1) * GAP;
                            return availColH / Math.max(0.01, colKs[cIdx]);
                        });

                        const startX = Math.max(0, (targetW - totalW) / 2);
                        const startY = Math.max(0, (targetH - H_opt) / 2);

                        let curX = startX;
                        cols.forEach((cList, cIdx) => {
                            const wCol = colWidths[cIdx];
                            let curY = startY;
                            cList.forEach(idx => {
                                const l = state.layers[idx];
                                const r = getNativeAspect(idx);
                                const hItem = wCol / r;
                                l.w = wCol;
                                l.h = hItem;
                                l.x = curX;
                                l.y = curY;
                                curY += hItem + GAP;
                            });
                            curX += wCol + GAP;
                        });
                    } else if (rows.length >= 1) {
                        // 横向分行代数求解：所有行宽度统一拉平为 W_opt，同行图片统一拉平为行高
                        const rowKs = rows.map(rList => {
                            return rList.reduce((acc, idx) => acc + getNativeAspect(idx), 0);
                        });
                        const sumInvK_row = rowKs.reduce((acc, K) => acc + (1.0 / Math.max(0.01, K)), 0);
                        const gapCorr_row = (rows.length - 1) * GAP - rows.reduce((acc, rList, rIdx) => {
                            return acc + ((rList.length - 1) * GAP) / Math.max(0.01, rowKs[rIdx]);
                        }, 0);

                        let W_req = (targetH - gapCorr_row) / Math.max(0.01, sumInvK_row);
                        let W_opt = Math.min(targetW, W_req);
                        let totalH = W_opt * sumInvK_row + gapCorr_row;

                        if (W_opt < targetW && (targetW * sumInvK_row + gapCorr_row) <= targetH) {
                            W_opt = targetW;
                            totalH = targetW * sumInvK_row + gapCorr_row;
                        }

                        const rowHeights = rows.map((rList, rIdx) => {
                            const availRowW = W_opt - (rList.length - 1) * GAP;
                            return availRowW / Math.max(0.01, rowKs[rIdx]);
                        });

                        const startX = Math.max(0, (targetW - W_opt) / 2);
                        const startY = Math.max(0, (targetH - totalH) / 2);

                        let curY = startY;
                        rows.forEach((rList, rIdx) => {
                            const hRow = rowHeights[rIdx];
                            let curX = startX;
                            rList.forEach(idx => {
                                const l = state.layers[idx];
                                const r = getNativeAspect(idx);
                                const wItem = hRow * r;
                                l.w = wItem;
                                l.h = hRow;
                                l.x = curX;
                                l.y = curY;
                                curX += wItem + GAP;
                            });
                            curY += hRow + GAP;
                        });
                    }
                }

                requestScreenRender();
                debouncedSave();
            };

            btnHero.onclick = () => executeAutoLayout("hero");
            btnGrid.onclick = () => executeAutoLayout("grid");
            btnRow.onclick = () => executeAutoLayout("row");
            btnCol.onclick = () => executeAutoLayout("col");
            btnTidy.onclick = () => executeAutoLayout("tidy");

            // 跟踪鼠标是否处于节点区域内，替代高开销的 root.matches(":hover")
            let isPointerInsideRoot = false;
            root.addEventListener("pointerenter", () => { isPointerInsideRoot = true; });
            root.addEventListener("pointerleave", () => { isPointerInsideRoot = false; });

            // 键盘快捷键监听（保存引用以便节点移除时销毁，防止多实例累积泄漏）
            const handleKeyDown = (e) => {
                if (!root.isConnected) return;
                const isHovered = isPointerInsideRoot || root.matches(":hover");
                if (!isHovered) return;

                // 裁剪模式下：Esc 取消、Enter 应用，且屏蔽删除键
                if (state.cropMode) {
                    if (e.key === "Escape" || e.key === "Enter" || e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        if (e.key === "Escape") exitCropMode();
                        else if (e.key === "Enter") applyCropMode();
                        return;
                    }
                }

                if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (e.shiftKey) {
                        btnRedo.click();
                    } else {
                        btnUndo.click();
                    }
                    return;
                }

                if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    btnRedo.click();
                    return;
                }

                if ((e.key === "Delete" || e.key === "Backspace") && (state.tool === "select")) {
                    const toDelete = state.selectedLayerIndices.length > 0 ? [...state.selectedLayerIndices] : (state.selectedLayerIndex >= 0 ? [state.selectedLayerIndex] : []);
                    if (toDelete.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        pushLayerSnapshot();
                        toDelete.sort((a, b) => b - a).forEach(idx => state.layers.splice(idx, 1));
                        state.selectedLayerIndices = [];
                        state.selectedLayerIndex = -1;
                        requestScreenRender();
                        debouncedSave();
                    }
                }
            };
            window.addEventListener("keydown", handleKeyDown, { capture: true });

            root.addEventListener("wheel", (e) => {
                if (app.canvas?.canvas) {
                    const syntheticEvent = new WheelEvent("wheel", {
                        clientX: e.clientX, clientY: e.clientY,
                        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
                        deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
                        altKey: e.altKey, bubbles: true, cancelable: true
                    });
                    app.canvas.canvas.dispatchEvent(syntheticEvent);
                }
            }, { passive: true });

            let isForwardingPan = false;
            const handleWindowPointerMove = (e) => {
                if (isForwardingPan && app.canvas?.canvas) {
                    app.canvas.canvas.dispatchEvent(new PointerEvent("pointermove", e));
                }
            };
            const handleWindowPointerUp = (e) => {
                if (isForwardingPan && app.canvas?.canvas) {
                    isForwardingPan = false;
                    app.canvas.canvas.dispatchEvent(new PointerEvent("pointerup", e));
                }
            };
            window.addEventListener("pointermove", handleWindowPointerMove);
            window.addEventListener("pointerup", handleWindowPointerUp);

            const applyDimensionsChange = (mode) => {
                const [newW, newH] = getPhysicalDimensions();
                const oldW = targetW;
                const oldH = targetH;
                if (newW === oldW && newH === oldH) return;

                targetW = newW;
                targetH = newH;

                const temp = document.createElement("canvas");
                temp.width = oldW;
                temp.height = oldH;
                temp.getContext("2d").drawImage(drawCanvas, 0, 0);

                drawCanvas.width = newW;
                drawCanvas.height = newH;
                drawCtx.imageSmoothingEnabled = true;
                drawCtx.imageSmoothingQuality = "high";
                exportCanvas.width = newW;
                exportCanvas.height = newH;

                if (mode === "tier") {
                    const scaleFactor = newW / oldW;
                    state.layers.forEach(l => {
                        l.x *= scaleFactor;
                        l.y *= scaleFactor;
                        l.w *= scaleFactor;
                        l.h *= scaleFactor;
                    });
                    drawCtx.drawImage(temp, 0, 0, newW, newH);
                } else {
                    const shiftX = (newW - oldW) / 2;
                    const shiftY = (newH - oldH) / 2;

                    state.layers.forEach(l => {
                        const aspect = getNativeAspect(state.layers.indexOf(l));
                        l.h = l.w / aspect;
                        l.x += shiftX;
                        l.y += shiftY;
                    });

                    drawCtx.drawImage(temp, shiftX, shiftY);
                }

                syncDisplayCanvasLayout();
                requestScreenRender();
                debouncedSave();
            };

            ratioSelect.onchange = () => {
                state.ratio = ratioSelect.value;
                applyDimensionsChange("ratio");
            };

            scaleSelect.onchange = () => {
                state.scaleTier = scaleSelect.value;
                applyDimensionsChange("tier");
            };

            bgSelect.onchange = () => {
                requestScreenRender();
                debouncedSave();
            };

            btnSave.onclick = () => {
                bakeCompositeImage();
                exportCanvas.toBlob((blob) => {
                    if (!blob) return;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.download = `crazy3ds_${state.ratio}_${state.scaleTier}_${Date.now()}.png`;
                    a.href = url;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }, "image/png");
            };

            const uploadCanvasBlob = (cvs, filename) => {
                return new Promise(resolve => {
                    cvs.toBlob(async blob => {
                        if (!blob) return resolve();
                        const formData = new FormData();
                        formData.append("image", blob, filename);
                        formData.append("subfolder", "crazy3ds_temp");
                        formData.append("overwrite", "true");
                        try {
                            await api.fetchApi("/upload/image", { method: "POST", body: formData });
                        } catch (e) {}
                        resolve();
                    }, "image/png");
                });
            };

            // 标记手绘层是否发生过修改，避免只移动图片图层时也重复压缩上传巨型透明手绘层
            let drawLayerDirty = true;

            const forceBakeAndUpload = async () => {
                bakeCompositeImage();
                await uploadCanvasBlob(exportCanvas, `node_${nodeInstance.id}.png`);
                if (fileWidget) fileWidget.value = `crazy3ds_temp/node_${nodeInstance.id}.png`;
                if (drawLayerDirty) {
                    await uploadCanvasBlob(drawCanvas, `draw_${nodeInstance.id}.png`);
                    drawLayerDirty = false;
                }
                for (const l of state.layers) {
                    if (l._needsUpload) {
                        await uploadCanvasBlob(l.canvas, `layer_${l.id}.png`);
                        l._needsUpload = false;
                    }
                }
            };
            nodeInstance.forceBakeAndUpload = forceBakeAndUpload;

            let saveTimer = null;
            const debouncedSave = () => {
                // 立即同步内存池与节点序列化属性（毫秒级无阻塞）
                window._crazy3ds_memory_store[nodeInstance.id] = {
                    layers: state.layers,
                    ratio: state.ratio,
                    scaleTier: state.scaleTier,
                    bg_color: bgSelect.value
                };

                nodeInstance.properties = nodeInstance.properties || {};
                nodeInstance.properties.ratio = state.ratio;
                nodeInstance.properties.scaleTier = state.scaleTier;
                nodeInstance.properties.bg_color = bgSelect.value;
                nodeInstance.properties.has_draw = true;
                nodeInstance.properties.layers = state.layers.map(l => ({
                    id: l.id,
                    x: l.x, y: l.y, w: l.w, h: l.h,
                    origW: l.origW, origH: l.origH,
                    rotation: l.rotation || 0,
                    flipH: !!l.flipH,
                    opacity: l.opacity !== undefined ? l.opacity : 1.0
                }));

                // 将高耗时的 2K/4K/8K PNG 烘焙与上传延后到停止连续操作 600ms 后执行，防止连续微调图层时阻塞鼠标事件
                clearTimeout(saveTimer);
                saveTimer = setTimeout(async () => {
                    if (state.isInteracting) {
                        debouncedSave();
                        return;
                    }
                    await forceBakeAndUpload();
                }, 600);
            };

            const ro = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                        applyHudFontScale();
                        syncDisplayCanvasLayout();
                        requestScreenRender();
                    }
                }
            });
            ro.observe(viewport);

            const handleVisibilityChange = () => {
                if (!document.hidden && viewport.clientWidth > 0) {
                    syncDisplayCanvasLayout();
                    requestScreenRender();
                }
            };
            document.addEventListener("visibilitychange", handleVisibilityChange);

            const restoreSavedData = () => {
                if (state.layers && state.layers.length > 0) {
                    syncDisplayCanvasLayout();
                    requestScreenRender();
                    return;
                }

                const cached = window._crazy3ds_memory_store[nodeInstance.id];
                if (cached && cached.layers && cached.layers.length > 0) {
                    state.layers = cached.layers;
                    if (cached.ratio) { state.ratio = cached.ratio; ratioSelect.value = cached.ratio; }
                    if (cached.scaleTier) { state.scaleTier = cached.scaleTier; scaleSelect.value = cached.scaleTier; }
                    [targetW, targetH] = getPhysicalDimensions();
                    drawCanvas.width = targetW; drawCanvas.height = targetH;
                    exportCanvas.width = targetW; exportCanvas.height = targetH;
                    syncDisplayCanvasLayout();
                    requestScreenRender();
                    return;
                }

                const props = nodeInstance.properties;
                if (!props) return;

                if (props.ratio && BASE_RATIOS[props.ratio]) {
                    state.ratio = props.ratio;
                    ratioSelect.value = props.ratio;
                }
                if (props.scaleTier && MULTIPLIERS[props.scaleTier]) {
                    state.scaleTier = props.scaleTier;
                    scaleSelect.value = props.scaleTier;
                }
                [targetW, targetH] = getPhysicalDimensions();
                drawCanvas.width = targetW; drawCanvas.height = targetH;
                exportCanvas.width = targetW; exportCanvas.height = targetH;
                if (props.bg_color) bgSelect.value = props.bg_color;

                if (props.has_draw) {
                    const img = new Image();
                    img.onload = () => {
                        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                        drawCtx.drawImage(img, 0, 0);
                        drawLayerDirty = false;
                        syncDisplayCanvasLayout();
                        requestScreenRender();
                    };
                    img.src = `/view?filename=draw_${nodeInstance.id}.png&subfolder=crazy3ds_temp&type=input&t=${Date.now()}`;
                }

                if (Array.isArray(props.layers) && props.layers.length > 0 && state.layers.length === 0) {
                    props.layers.forEach(l => {
                        const img = new Image();
                        img.onload = () => {
                            const lCanvas = document.createElement("canvas");
                            lCanvas.width = l.origW; lCanvas.height = l.origH;
                            const lCtx = lCanvas.getContext("2d", { willReadFrequently: true });
                            lCtx.imageSmoothingEnabled = true;
                            lCtx.imageSmoothingQuality = "high";
                            lCtx.drawImage(img, 0, 0);

                            state.layers.push({
                                id: l.id,
                                canvas: lCanvas, ctx: lCtx,
                                x: l.x, y: l.y, w: l.w, h: l.h,
                                origW: l.origW, origH: l.origH,
                                rotation: l.rotation || 0,
                                flipH: !!l.flipH,
                                opacity: l.opacity !== undefined ? l.opacity : 1.0,
                                _needsUpload: false
                            });
                            syncRotationSlider();
                            syncDisplayCanvasLayout();
                            requestScreenRender();
                        };
                        img.src = `/view?filename=layer_${l.id}.png&subfolder=crazy3ds_temp&type=input&t=${Date.now()}`;
                    });
                }
            };

            const origOnConfigure = this.onConfigure;
            this.onConfigure = function () {
                origOnConfigure?.apply(this, arguments);
                restoreSavedData();
            };

            const autoCropTransparentBorders = (img) => {
                const tw = img.naturalWidth || img.width;
                const th = img.naturalHeight || img.height;
                if (tw <= 0 || th <= 0) return { canvas: document.createElement("canvas"), width: 1, height: 1 };

                const thumbMax = 512;
                const thumbScale = Math.min(1.0, thumbMax / Math.max(tw, th));
                const thumbW = Math.max(16, Math.round(tw * thumbScale));
                const thumbH = Math.max(16, Math.round(th * thumbScale));

                const scanCanvas = document.createElement("canvas");
                scanCanvas.width = thumbW;
                scanCanvas.height = thumbH;
                const sCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
                sCtx.drawImage(img, 0, 0, thumbW, thumbH);

                const imgData = sCtx.getImageData(0, 0, thumbW, thumbH);
                const data = imgData.data;

                let minX = thumbW, minY = thumbH, maxX = -1, maxY = -1;
                let hasTransparent = false;

                for (let y = 0; y < thumbH; y++) {
                    for (let x = 0; x < thumbW; x++) {
                        const alpha = data[(y * thumbW + x) * 4 + 3];
                        if (alpha < 240) hasTransparent = true;
                        if (alpha > 15) {
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }
                }

                if (!hasTransparent || maxX < minX || maxY < minY || (minX <= 2 && minY <= 2 && maxX >= thumbW - 3 && maxY >= thumbH - 3)) {
                    const fullCanvas = document.createElement("canvas");
                    fullCanvas.width = tw;
                    fullCanvas.height = th;
                    const fCtx = fullCanvas.getContext("2d", { willReadFrequently: true });
                    fCtx.imageSmoothingEnabled = true;
                    fCtx.imageSmoothingQuality = "high";
                    fCtx.drawImage(img, 0, 0);
                    return { canvas: fullCanvas, width: tw, height: th };
                }

                const invScale = 1.0 / thumbScale;
                const origMinX = Math.max(0, Math.floor((minX - 1) * invScale));
                const origMinY = Math.max(0, Math.floor((minY - 1) * invScale));
                const origMaxX = Math.min(tw - 1, Math.ceil((maxX + 2) * invScale));
                const origMaxY = Math.min(th - 1, Math.ceil((maxY + 2) * invScale));

                const cropW = origMaxX - origMinX + 1;
                const cropH = origMaxY - origMinY + 1;

                const croppedCanvas = document.createElement("canvas");
                croppedCanvas.width = cropW;
                croppedCanvas.height = cropH;
                const cCtx = croppedCanvas.getContext("2d", { willReadFrequently: true });
                cCtx.imageSmoothingEnabled = true;
                cCtx.imageSmoothingQuality = "high";
                cCtx.drawImage(img, origMinX, origMinY, cropW, cropH, 0, 0, cropW, cropH);

                return { canvas: croppedCanvas, width: cropW, height: cropH };
            };

            const createLayerFromImage = (img) => {
                const { canvas: lCanvas, width: origW, height: origH } = autoCropTransparentBorders(img);
                const lCtx = lCanvas.getContext("2d", { willReadFrequently: true });
                lCtx.imageSmoothingEnabled = true;
                lCtx.imageSmoothingQuality = "high";

                const aspect = origW / origH;
                let w, h;
                if (origW <= targetW * 0.85 && origH <= targetH * 0.85) {
                    w = origW;
                    h = origH;
                } else {
                    w = targetW * 0.85;
                    h = w / aspect;
                    if (h > targetH * 0.85) {
                        h = targetH * 0.85;
                        w = h * aspect;
                    }
                }

                pushLayerSnapshot();
                state.layers.push({
                    id: "l_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                    canvas: lCanvas, ctx: lCtx,
                    x: (targetW - w) / 2, y: (targetH - h) / 2,
                    w, h, origW, origH,
                    rotation: 0, flipH: false,
                    opacity: 1.0,
                    _needsUpload: true
                });
                state.selectedLayerIndex = state.layers.length - 1;
                state.selectedLayerIndices = [state.selectedLayerIndex];
                state.tool = "select";
                updateBtns();
                layerOpSlider.value = "100";
                syncRotationSlider();
                requestScreenRender();
                debouncedSave();
            };

            const addImageLayerFromBlob = (blob) => {
                return new Promise((resolve) => {
                    const img = new Image();
                    const objectUrl = URL.createObjectURL(blob);
                    img.onload = () => {
                        try { createLayerFromImage(img); } catch (_) {}
                        URL.revokeObjectURL(objectUrl);
                        resolve();
                    };
                    img.onerror = () => {
                        URL.revokeObjectURL(objectUrl);
                        resolve();
                    };
                    img.src = objectUrl;
                });
            };

            btnFetchUpstream.onclick = async () => {
                const inputSlot = nodeInstance.inputs?.find(inp => inp.name === "images");
                if (!inputSlot || inputSlot.link == null) {
                    alert("请先将上游图像节点连接到本节点的 images 输入插槽！");
                    return;
                }
                const link = app.graph.links[inputSlot.link];
                if (!link) return;
                const originNodeId = link.origin_id;
                const originOutput = app.nodeOutputs?.[originNodeId];
                if (!originOutput || !originOutput.images || originOutput.images.length === 0) {
                    alert("上游节点尚未运行输出图像，请先运行一次上游工作流！");
                    return;
                }

                // 支持多图：上游输出为多张（批次 / 列表）时逐张载入为独立图层
                const imgList = Array.from(originOutput.images);
                let added = 0;
                for (let i = 0; i < imgList.length; i++) {
                    const item = imgList[i];
                    if (!item || !item.filename) continue;
                    const srcUrl = `/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || "")}&type=${encodeURIComponent(item.type || "output")}`;
                    try {
                        const resp = await fetch(srcUrl);
                        if (!resp.ok) continue;
                        const blob = await resp.blob();
                        const beforeCount = state.layers.length;
                        await addImageLayerFromBlob(blob);
                        if (state.layers.length > beforeCount) {
                            added++;
                            // 多图载入时逐级错位，避免所有图层完全重叠而无法分辨
                            if (added > 1) {
                                const nl = state.layers[state.layers.length - 1];
                                const step = 26 * (added - 1);
                                nl.x = Math.min(Math.max(0, nl.x + step), Math.max(0, targetW - nl.w));
                                nl.y = Math.min(Math.max(0, nl.y + step), Math.max(0, targetH - nl.h));
                            }
                        }
                    } catch (_) {}
                }

                if (added > 1) {
                    requestScreenRender();
                    debouncedSave();
                }
            };

            const handlePaste = (e) => {
                if (!root.isConnected) return;
                const isHovered = isPointerInsideRoot || root.matches(":hover");
                const isSelected = app.canvas?.selected_nodes?.[nodeInstance.id];
                if (!isHovered && !isSelected) return;

                const items = e.clipboardData?.items;
                if (items) {
                    for (const item of items) {
                        if (item.type.startsWith("image/")) {
                            const blob = item.getAsFile();
                            if (blob) addImageLayerFromBlob(blob);
                        }
                    }
                }
            };
            window.addEventListener("paste", handlePaste);

            // 节点被删除时清理全局事件监听与定时器，防止多节点/删建节点后事件堆积卡顿
            const origOnRemoved = this.onRemoved;
            this.onRemoved = function () {
                origOnRemoved?.apply(this, arguments);
                clearTimeout(saveTimer);
                try { ro.disconnect(); } catch (_) {}
                window.removeEventListener("keydown", handleKeyDown, { capture: true });
                window.removeEventListener("pointermove", handleWindowPointerMove);
                window.removeEventListener("pointerup", handleWindowPointerUp);
                window.removeEventListener("paste", handlePaste);
                document.removeEventListener("visibilitychange", handleVisibilityChange);
            };

            viewport.addEventListener("dragover", (e) => { e.preventDefault(); });
            viewport.addEventListener("drop", (e) => {
                e.preventDefault();
                if (e.dataTransfer?.files) {
                    Array.from(e.dataTransfer.files).forEach(file => {
                        if (file.type.startsWith("image/")) addImageLayerFromBlob(file);
                    });
                }
            });

            fileInput.onchange = (e) => {
                Array.from(e.target.files).forEach(file => addImageLayerFromBlob(file));
                fileInput.value = "";
            };

            const toCanvasCoords = (e) => {
                const rect = displayCanvas.getBoundingClientRect();
                if (!rect.width || !rect.height) return { x: 0, y: 0 };
                const x = (e.clientX - rect.left) * (targetW / rect.width);
                const y = (e.clientY - rect.top) * (targetH / rect.height);
                return { x, y };
            };

            const toLayerBoxCoords = (pos, layer) => {
                const cx = layer.x + layer.w / 2;
                const cy = layer.y + layer.h / 2;
                let dx = pos.x - cx;
                let dy = pos.y - cy;

                const rad = -((layer.rotation || 0) * Math.PI) / 180;
                let rx = dx * Math.cos(rad) - dy * Math.sin(rad);
                let ry = dx * Math.sin(rad) + dy * Math.cos(rad);

                const isInside = rx >= -layer.w / 2 && rx <= layer.w / 2 && ry >= -layer.h / 2 && ry <= layer.h / 2;
                return { rx, ry, isInside };
            };

            const toLayerPixelCoords = (pos, layer) => {
                const cx = layer.x + layer.w / 2;
                const cy = layer.y + layer.h / 2;
                let dx = pos.x - cx;
                let dy = pos.y - cy;

                const rad = -((layer.rotation || 0) * Math.PI) / 180;
                let rx = dx * Math.cos(rad) - dy * Math.sin(rad);
                let ry = dx * Math.sin(rad) + dy * Math.cos(rad);

                if (layer.flipH) rx = -rx;

                const lx = (rx / layer.w + 0.5) * layer.origW;
                const ly = (ry / layer.h + 0.5) * layer.origH;
                return { lx, ly };
            };

            const checkLayerHitTest = (layer, pos) => {
                const box = toLayerBoxCoords(pos, layer);
                if (!box.isInside) return { inside: false, hasPixel: false };

                const pix = toLayerPixelCoords(pos, layer);
                if (pix.lx >= 0 && pix.lx < layer.origW && pix.ly >= 0 && pix.ly < layer.origH) {
                    try {
                        const alpha = layer.ctx.getImageData(Math.floor(pix.lx), Math.floor(pix.ly), 1, 1).data[3];
                        return { inside: true, hasPixel: alpha > 15 };
                    } catch (e) {
                        return { inside: true, hasPixel: true };
                    }
                }
                return { inside: true, hasPixel: false };
            };

            let startPointer = { x: 0, y: 0 };
            let layerInitRect = { x: 0, y: 0, w: 0, h: 0 };
            let layerInitRectsMap = {};
            let lastLocalPoint = null;
            let rotateInit = { rotation: 0, startAngle: 0 };

            viewport.addEventListener("pointerdown", (e) => {
                if (e.button === 2) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (state.cropMode) return;
                    if (state.tool !== "select") {
                        state.tool = "select";
                        updateBtns();
                        requestScreenRender();
                    } else {
                        if (state.selectedLayerIndex >= 0 || state.selectedLayerIndices.length > 0) {
                            state.selectedLayerIndex = -1;
                            state.selectedLayerIndices = [];
                            requestScreenRender();
                        }
                    }
                    return;
                }

                if (e.button === 1 || (e.button === 0 && (app.canvas?.space_is_pressed || e.spaceKey))) {
                    isForwardingPan = true;
                    if (app.canvas?.canvas) {
                        app.canvas.canvas.dispatchEvent(new PointerEvent("pointerdown", e));
                    }
                    return;
                }

                if (e.button !== 0) return;
                // 阻止左键点击冒泡到 LiteGraph 画布，彻底避免画布拦截指针导致点击失效或拖拽节点冲突
                e.stopPropagation();

                const pos = toCanvasCoords(e);
                startPointer = { x: pos.x, y: pos.y };
                state.isInteracting = true;
                state.hasModified = false;
                try { viewport.setPointerCapture(e.pointerId); } catch (_) {}

                // 裁剪模式：优先接管指针，用于移动 / 缩放裁剪框
                if (state.cropMode) {
                    const layer = getCropTargetLayer();
                    if (layer && state.cropRect && layer.id === state.cropLayerId) {
                        const ratio = targetW / Math.max(1, currentLayout.dispW);
                        const p = canvasPosToDrawBox(pos, layer);
                        const db = cropRectToDrawBox(layer, state.cropRect);
                        const tol = Math.max(8, 9 * ratio);
                        const hs = Math.max(10, Math.min(20, 7 * ratio));
                        const tolPx = Math.max(tol, hs);

                        const hx = [db.x, db.x + db.w / 2, db.x + db.w];
                        const hy = [db.y, db.y + db.h / 2, db.y + db.h];
                        const names = [["tl", "t", "tr"], ["l", null, "r"], ["bl", "b", "br"]];

                        let hitHandle = null;
                        for (let iy = 0; iy < 3 && !hitHandle; iy++) {
                            for (let ix = 0; ix < 3 && !hitHandle; ix++) {
                                const nm = names[iy][ix];
                                if (!nm) continue;
                                if (Math.abs(p.x - hx[ix]) <= tolPx && Math.abs(p.y - hy[iy]) <= tolPx) hitHandle = nm;
                            }
                        }

                        if (hitHandle) {
                            state.cropAction = "resize";
                            state.cropHandle = hitHandle;
                        } else if (p.x >= db.x && p.x <= db.x + db.w && p.y >= db.y && p.y <= db.y + db.h) {
                            state.cropAction = "move";
                            state.cropHandle = null;
                        } else {
                            state.cropAction = null;
                            state.cropHandle = null;
                        }

                        if (state.cropAction) {
                            state.cropInitRect = { ...state.cropRect };
                            state.cropInitPointer = { x: p.x, y: p.y };
                        }
                        requestScreenRender();
                    }
                    return;
                }

                if (state.tool === "eyedropper") {
                    bakeCompositeImage();
                    const px = Math.min(targetW - 1, Math.max(0, Math.floor(pos.x)));
                    const py = Math.min(targetH - 1, Math.max(0, Math.floor(pos.y)));
                    const pData = expCtx.getImageData(px, py, 1, 1).data;
                    const hex = `#${((1 << 24) + (pData[0] << 16) + (pData[1] << 8) + pData[2]).toString(16).slice(1)}`;

                    state.brushColor = hex;
                    nativeColor.value = hex;
                    state.tool = "brush";
                    updateBtns();
                    updateActiveColorUI();
                    state.isInteracting = false;
                    try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
                    requestScreenRender();
                    return;
                }

                if (state.tool === "layer_eraser") {
                    if (state.selectedLayerIndex >= 0) {
                        const sel = state.layers[state.selectedLayerIndex];
                        if (state.history.length >= 15) state.history.shift();
                        state.history.push({
                            type: "layer",
                            layerId: sel.id,
                            data: sel.ctx.getImageData(0, 0, sel.canvas.width, sel.canvas.height)
                        });
                        state.redoStack = [];

                        const loc = toLayerPixelCoords(pos, sel);
                        lastLocalPoint = { x: loc.lx, y: loc.ly };

                        const radius = (state.layerEraserSize / sel.w) * sel.origW * 0.5;
                        sel.ctx.save();
                        sel.ctx.globalCompositeOperation = "destination-out";
                        sel.ctx.beginPath();
                        sel.ctx.arc(loc.lx, loc.ly, radius, 0, Math.PI * 2);
                        sel.ctx.fill();
                        sel.ctx.restore();
                        sel._needsUpload = true;
                        state.hasModified = true;
                        requestScreenRender();
                    }
                    return;
                }

                if (state.tool === "select") {
                    const ratio = targetW / Math.max(1, currentLayout.dispW);

                    if (state.selectedLayerIndex >= 0) {
                        const sel = state.layers[state.selectedLayerIndex];
                        const loc = toLayerBoxCoords(pos, sel);

                        const hs = Math.max(12, Math.min(24, 8 * ratio));

                        const delRadius = Math.max(7, 6.5 * ratio);
                        const offset = hs + 10 * ratio;
                        const delCenterX = sel.w / 2 - offset;
                        const delCenterY = -sel.h / 2 + offset;
                        const distToDel = Math.hypot(loc.rx - delCenterX, loc.ry - delCenterY);

                        if (distToDel <= delRadius * 1.5) {
                            pushLayerSnapshot();
                            const toDelete = state.selectedLayerIndices.length > 0 ? [...state.selectedLayerIndices] : [state.selectedLayerIndex];
                            toDelete.sort((a, b) => b - a).forEach(idx => state.layers.splice(idx, 1));
                            state.selectedLayerIndices = [];
                            state.selectedLayerIndex = -1;
                            state.isInteracting = false;
                            try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
                            requestScreenRender();
                            debouncedSave();
                            return;
                        }

                        const clickTolerance = Math.max(hs * 1.2, 16 * ratio);
                        const corners = [
                            { name: "tl", x: -sel.w / 2, y: -sel.h / 2 },
                            { name: "tr", x: sel.w / 2, y: -sel.h / 2 },
                            { name: "bl", x: -sel.w / 2, y: sel.h / 2 },
                            { name: "br", x: sel.w / 2, y: sel.h / 2 }
                        ];

                        // 自由旋转手柄命中检测（优先于四角缩放，避免手柄落在角落附近时误触发缩放）
                        const rotHandleWorld = getRotateHandleWorldPos(sel, hs);
                        const rotHitRadius = Math.max(10, 9 * ratio);
                        if (Math.hypot(pos.x - rotHandleWorld.x, pos.y - rotHandleWorld.y) <= rotHitRadius) {
                            state.actionType = "rotate_layer";
                            beginLayerSnapshot();
                            const selCx = sel.x + sel.w / 2;
                            const selCy = sel.y + sel.h / 2;
                            rotateInit = {
                                rotation: sel.rotation || 0,
                                startAngle: (Math.atan2(pos.y - selCy, pos.x - selCx) * 180) / Math.PI
                            };
                            return;
                        }

                        for (const c of corners) {
                            if (Math.abs(loc.rx - c.x) <= clickTolerance && Math.abs(loc.ry - c.y) <= clickTolerance) {
                                state.actionType = "resize_layer";
                                state.resizeCorner = c.name;
                                beginLayerSnapshot();
                                layerInitRect = { ...sel };
                                return;
                            }
                        }
                    }

                    const hits = [];
                    for (let i = state.layers.length - 1; i >= 0; i--) {
                        const res = checkLayerHitTest(state.layers[i], pos);
                        if (res.inside) {
                            hits.push({ index: i, hasPixel: res.hasPixel });
                        }
                    }

                    let hit = -1;
                    if (hits.length > 0) {
                        const pixelHits = hits.filter(h => h.hasPixel).map(h => h.index);
                        const candidates = pixelHits.length > 0 ? pixelHits : hits.map(h => h.index);

                        if (e.altKey) {
                            e.preventDefault();
                            const curPosInList = candidates.indexOf(state.selectedLayerIndex);
                            if (curPosInList >= 0) {
                                hit = candidates[(curPosInList + 1) % candidates.length];
                            } else {
                                hit = candidates[0];
                            }
                        } else {
                            hit = candidates[0];
                        }
                    }

                    if (hit >= 0) {
                        if (e.shiftKey) {
                            const existsIdx = state.selectedLayerIndices.indexOf(hit);
                            if (existsIdx >= 0) {
                                state.selectedLayerIndices.splice(existsIdx, 1);
                                state.selectedLayerIndex = state.selectedLayerIndices.length > 0 ? state.selectedLayerIndices[state.selectedLayerIndices.length - 1] : -1;
                            } else {
                                state.selectedLayerIndices.push(hit);
                                state.selectedLayerIndex = hit;
                            }
                        } else {
                            if (!state.selectedLayerIndices.includes(hit)) {
                                state.selectedLayerIndices = [hit];
                                state.selectedLayerIndex = hit;
                            }
                        }

                        state.actionType = "drag_layer";
                        beginLayerSnapshot();
                        layerInitRectsMap = {};
                        state.selectedLayerIndices.forEach(idx => {
                            if (state.layers[idx]) {
                                layerInitRectsMap[idx] = { x: state.layers[idx].x, y: state.layers[idx].y };
                            }
                        });
                        layerOpSlider.value = Math.round((state.layers[hit].opacity !== undefined ? state.layers[hit].opacity : 1.0) * 100);
                        syncRotationSlider();
                    } else {
                        if (!e.shiftKey) {
                            state.selectedLayerIndices = [];
                            state.selectedLayerIndex = -1;
                        }
                        state.actionType = "box_select";
                        state.boxSelectRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
                    }
                    requestScreenRender();
                } else {
                    state.actionType = "paint";
                    if (state.history.length >= 15) state.history.shift();
                    state.history.push({
                        type: "draw",
                        data: drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)
                    });
                    state.redoStack = [];

                    drawCtx.save();
                    drawCtx.beginPath();
                    drawCtx.moveTo(pos.x, pos.y);
                    drawCtx.lineCap = "round";
                    drawCtx.lineJoin = "round";
                    drawCtx.lineWidth = state.brushSize;

                    if (state.tool === "eraser") {
                        drawCtx.globalCompositeOperation = "destination-out";
                        drawCtx.strokeStyle = "rgba(0,0,0,1)";
                    } else {
                        drawCtx.globalCompositeOperation = "source-over";
                        drawCtx.globalAlpha = state.brushOpacity;
                        drawCtx.strokeStyle = state.brushColor;
                    }
                    // 单击点按时立即绘制圆点，避免点一下不出墨
                    drawCtx.lineTo(pos.x, pos.y);
                    drawCtx.stroke();
                    drawLayerDirty = true;
                    state.hasModified = true;
                    requestScreenRender();
                }
            });

            viewport.addEventListener("pointermove", (e) => {
                const pos = toCanvasCoords(e);
                state.mousePos = { x: pos.x, y: pos.y };

                if (!state.isInteracting) {
                    // 仅在需要跟随鼠标渲染准星/笔刷圆圈的工具下重绘，移动模式(select)下划过鼠标不触发全画布合成重绘
                    if (
                        state.tool === "eyedropper" ||
                        state.tool === "brush" ||
                        state.tool === "eraser" ||
                        state.tool === "layer_eraser"
                    ) {
                        requestScreenRender();
                    }
                    return;
                }

                // 裁剪模式：拖拽移动 / 八向手柄缩放裁剪框
                if (state.cropMode) {
                    if (state.cropAction && state.cropInitRect) {
                        const layer = getCropTargetLayer();
                        if (layer && layer.id === state.cropLayerId) {
                            const p = canvasPosToDrawBox(pos, layer);
                            const dix = (p.x - state.cropInitPointer.x) * (layer.origW / layer.w);
                            const diy = (p.y - state.cropInitPointer.y) * (layer.origH / layer.h);
                            const init = state.cropInitRect;
                            const lock = state.cropRatioLock;

                            if (state.cropAction === "move") {
                                state.cropRect = clampCropRect(
                                    { x: init.x + dix, y: init.y + diy, w: init.w, h: init.h },
                                    layer.origW, layer.origH, lock
                                );
                            } else {
                                const nm = state.cropHandle || "br";
                                let x0 = init.x, y0 = init.y, x1 = init.x + init.w, y1 = init.y + init.h;
                                if (nm.indexOf("l") >= 0) x0 += dix;
                                if (nm.indexOf("r") >= 0) x1 += dix;
                                if (nm.indexOf("t") >= 0) y0 += diy;
                                if (nm.indexOf("b") >= 0) y1 += diy;

                                if (lock) {
                                    if (nm === "l" || nm === "r") {
                                        const w = Math.abs(x1 - x0);
                                        const h = w / lock;
                                        const yc = init.y + init.h / 2;
                                        y0 = yc - h / 2; y1 = yc + h / 2;
                                    } else if (nm === "t" || nm === "b") {
                                        const h = Math.abs(y1 - y0);
                                        const w = h * lock;
                                        const xc = init.x + init.w / 2;
                                        x0 = xc - w / 2; x1 = xc + w / 2;
                                    } else {
                                        const anchorX = nm.indexOf("l") >= 0 ? (init.x + init.w) : init.x;
                                        const anchorY = nm.indexOf("t") >= 0 ? (init.y + init.h) : init.y;
                                        let w = Math.abs(x1 - x0);
                                        let h = Math.abs(y1 - y0);
                                        if (w / Math.max(1e-6, h) > lock) h = w / lock; else w = h * lock;
                                        if (nm.indexOf("l") >= 0) x0 = anchorX - w; else x0 = anchorX;
                                        if (nm.indexOf("t") >= 0) y0 = anchorY - h; else y0 = anchorY;
                                        x1 = x0 + w; y1 = y0 + h;
                                    }
                                }

                                if (x1 < x0) { const tmp = x0; x0 = x1; x1 = tmp; }
                                if (y1 < y0) { const tmp = y0; y0 = y1; y1 = tmp; }

                                state.cropRect = clampCropRect(
                                    { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
                                    layer.origW, layer.origH, lock
                                );
                            }
                        }
                    }
                    requestScreenRender();
                    return;
                }

                if (state.tool === "layer_eraser" && state.selectedLayerIndex >= 0) {
                    const sel = state.layers[state.selectedLayerIndex];
                    const loc = toLayerPixelCoords(pos, sel);
                    const radius = (state.layerEraserSize / sel.w) * sel.origW * 0.5;

                    sel.ctx.save();
                    sel.ctx.globalCompositeOperation = "destination-out";
                    sel.ctx.lineWidth = radius * 2;
                    sel.ctx.lineCap = "round";
                    sel.ctx.lineJoin = "round";
                    sel.ctx.beginPath();
                    if (lastLocalPoint) {
                        sel.ctx.moveTo(lastLocalPoint.x, lastLocalPoint.y);
                    } else {
                        sel.ctx.moveTo(loc.lx, loc.ly);
                    }
                    sel.ctx.lineTo(loc.lx, loc.ly);
                    sel.ctx.stroke();
                    sel.ctx.restore();
                    sel._needsUpload = true;
                    state.hasModified = true;

                    lastLocalPoint = { x: loc.lx, y: loc.ly };
                    requestScreenRender();
                    return;
                }

                const dx = pos.x - startPointer.x;
                const dy = pos.y - startPointer.y;

                if (state.actionType === "drag_layer") {
                    if (dx !== 0 || dy !== 0) {
                        commitLayerSnapshot();
                        state.hasModified = true;
                    }
                    state.selectedLayerIndices.forEach(idx => {
                        const sel = state.layers[idx];
                        const initPos = layerInitRectsMap[idx];
                        if (sel && initPos) {
                            sel.x = initPos.x + dx;
                            sel.y = initPos.y + dy;
                        }
                    });
                    requestScreenRender();
                } else if (state.actionType === "resize_layer" && state.selectedLayerIndex >= 0) {
                    const sel = state.layers[state.selectedLayerIndex];
                    const aspect = getNativeAspect(state.selectedLayerIndex);
                    const r = layerInitRect;
                    if (dx !== 0 || dy !== 0) {
                        commitLayerSnapshot();
                        state.hasModified = true;
                    }

                    const rot = ((r.rotation || 0) * Math.PI) / 180;
                    const cos = Math.cos(rot);
                    const sin = Math.sin(rot);

                    // 初始物理中心点
                    const cx0 = r.x + r.w / 2;
                    const cy0 = r.y + r.h / 2;

                    // 确定对角锚点（在该缩放过程中绝对静止的对角点）及其自身局部坐标
                    let aLocalX, aLocalY, ux, uy;
                    if (state.resizeCorner === "br") {
                        aLocalX = -r.w / 2; aLocalY = -r.h / 2; // 固定 tl
                        ux = r.w; uy = r.h;
                    } else if (state.resizeCorner === "bl") {
                        aLocalX = r.w / 2; aLocalY = -r.h / 2;  // 固定 tr
                        ux = -r.w; uy = r.h;
                    } else if (state.resizeCorner === "tr") {
                        aLocalX = -r.w / 2; aLocalY = r.h / 2;  // 固定 bl
                        ux = r.w; uy = -r.h;
                    } else if (state.resizeCorner === "tl") {
                        aLocalX = r.w / 2; aLocalY = r.h / 2;   // 固定 br
                        ux = -r.w; uy = -r.h;
                    }

                    // 计算静止锚点在画布世界中的绝对位置
                    const aWorldX = cx0 + (aLocalX * cos - aLocalY * sin);
                    const aWorldY = cy0 + (aLocalX * sin + aLocalY * cos);

                    // 计算当前鼠标位置相对于静止对角锚点的世界位移并逆旋转回物体局部坐标系
                    const deltaX = pos.x - aWorldX;
                    const deltaY = pos.y - aWorldY;
                    const dLocalX = deltaX * cos + deltaY * sin;
                    const dLocalY = -deltaX * sin + deltaY * cos;

                    // 沿着对角线向量进行标量投影，求得平滑等比缩放因子
                    const uLenSq = ux * ux + uy * uy;
                    let factor = (dLocalX * ux + dLocalY * uy) / uLenSq;
                    factor = Math.max(25 / r.w, factor);

                    const newW = r.w * factor;
                    const newH = newW / aspect;

                    // 根据缩放后的新尺寸和静止锚点反解出最新物理中心点
                    const aNewLocalX = (aLocalX > 0 ? 0.5 : -0.5) * newW;
                    const aNewLocalY = (aLocalY > 0 ? 0.5 : -0.5) * newH;
                    const newOffsetGX = aNewLocalX * cos - aNewLocalY * sin;
                    const newOffsetGY = aNewLocalX * sin + aNewLocalY * cos;

                    const cxNew = aWorldX - newOffsetGX;
                    const cyNew = aWorldY - newOffsetGY;

                    sel.w = newW;
                    sel.h = newH;
                    sel.x = cxNew - newW / 2;
                    sel.y = cyNew - newH / 2;
                    requestScreenRender();
                } else if (state.actionType === "rotate_layer" && state.selectedLayerIndex >= 0) {
                    const sel = state.layers[state.selectedLayerIndex];
                    if (sel) {
                        if (dx !== 0 || dy !== 0) {
                            commitLayerSnapshot();
                            state.hasModified = true;
                        }
                        const selCx = sel.x + sel.w / 2;
                        const selCy = sel.y + sel.h / 2;
                        const curAngle = (Math.atan2(pos.y - selCy, pos.x - selCx) * 180) / Math.PI;
                        let deg = rotateInit.rotation + (curAngle - rotateInit.startAngle);
                        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
                        deg = normalizeDeg(deg);

                        state.selectedLayerIndices.forEach(idx => {
                            const l = state.layers[idx];
                            if (l) l.rotation = deg;
                        });
                        rotLabel.textContent = `旋转: ${Math.round(deg)}°`;
                        rotSlider.value = String(Math.min(359, Math.round(deg)));
                        requestScreenRender();
                    }
                } else if (state.actionType === "box_select" && state.boxSelectRect) {
                    state.boxSelectRect.w = pos.x - startPointer.x;
                    state.boxSelectRect.h = pos.y - startPointer.y;
                    requestScreenRender();
                } else if (state.actionType === "paint") {
                    drawCtx.lineTo(pos.x, pos.y);
                    drawCtx.stroke();
                    drawLayerDirty = true;
                    state.hasModified = true;
                    requestScreenRender();
                }
            });

            const stopAction = (e) => {
                if (e && e.pointerId !== undefined) {
                    try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
                }
                if (state.isInteracting) {
                    if (state.actionType === "box_select" && state.boxSelectRect) {
                        const { x, y, w, h } = state.boxSelectRect;
                        const rx = w < 0 ? x + w : x;
                        const ry = h < 0 ? y + h : y;
                        const rw = Math.abs(w);
                        const rh = Math.abs(h);

                        if (rw > 5 || rh > 5) {
                            state.layers.forEach((l, idx) => {
                                const overlap = !(l.x > rx + rw || l.x + l.w < rx || l.y > ry + rh || l.y + l.h < ry);
                                if (overlap && !state.selectedLayerIndices.includes(idx)) {
                                    state.selectedLayerIndices.push(idx);
                                }
                            });
                            if (state.selectedLayerIndices.length > 0) {
                                state.selectedLayerIndex = state.selectedLayerIndices[state.selectedLayerIndices.length - 1];
                            }
                        }
                        state.boxSelectRect = null;
                    }

                    const needSave = state.hasModified;
                    state.isInteracting = false;
                    state.hasModified = false;
                    pendingSnapshot = null;
                    state.actionType = null;
                    state.cropAction = null;
                    state.cropHandle = null;
                    lastLocalPoint = null;
                    if (state.tool === "brush" || state.tool === "eraser") {
                        drawCtx.restore();
                    }
                    requestScreenRender();
                    if (needSave) {
                        debouncedSave();
                    }
                }
            };
            viewport.addEventListener("pointerup", stopAction);
            viewport.addEventListener("pointercancel", stopAction);
            viewport.addEventListener("pointerleave", () => {
                state.mousePos = { x: -100, y: -100 };
                // 仅在未拖拽且处于笔刷/吸管工具时重绘以隐藏画笔圆圈，不再误调 stopAction 导致拖拽中断或触发无意义的 PNG 编码上传
                if (
                    !state.isInteracting &&
                    (state.tool === "brush" || state.tool === "eraser" || state.tool === "layer_eraser" || state.tool === "eyedropper")
                ) {
                    requestScreenRender();
                }
            });
            viewport.addEventListener("contextmenu", (e) => e.preventDefault());

            // 撤销/重做后同步参数卡上的滑块显示
            const syncLayerPanelUI = () => {
                const cur = state.layers[state.selectedLayerIndex];
                layerOpSlider.value = String(Math.round((cur && cur.opacity !== undefined ? cur.opacity : 1.0) * 100));
                syncRotationSlider();
            };

            // 裁剪类操作：整体换回某个画布 + 几何状态
            const applyCanvasStateEntry = (layerId, st) => {
                const l = state.layers.find(item => item.id === layerId);
                if (!l || !st) return;
                l.canvas = st.canvas; l.ctx = st.ctx;
                l.origW = st.origW; l.origH = st.origH;
                l.x = st.x; l.y = st.y; l.w = st.w; l.h = st.h;
                l._needsUpload = true;
                syncLayerPanelUI();
            };

            btnUndo.onclick = () => {
                if (state.cropMode) exitCropMode();
                if (state.history.length > 0) {
                    const action = state.history.pop();
                    if (action.type === "draw") {
                        state.redoStack.push({
                            type: "draw",
                            data: drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)
                        });
                        drawCtx.putImageData(action.data, 0, 0);
                        drawLayerDirty = true;
                    } else if (action.type === "layer") {
                        const l = state.layers.find(item => item.id === action.layerId);
                        if (l) {
                            state.redoStack.push({
                                type: "layer",
                                layerId: l.id,
                                data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height)
                            });
                            l.ctx.putImageData(action.data, 0, 0);
                            l._needsUpload = true;
                        }
                    } else if (action.type === "snapshot") {
                        state.redoStack.push({ type: "snapshot", snap: captureLayerSnapshot() });
                        restoreLayerSnapshot(action.snap);
                        syncLayerPanelUI();
                    } else if (action.type === "canvas") {
                        state.redoStack.push(action);
                        applyCanvasStateEntry(action.layerId, action.before);
                    } else if (action.type === "layout") {
                        state.redoStack.push({
                            type: "layout",
                            layers: state.layers.map(l => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }))
                        });
                        action.layers.forEach(item => {
                            const targetLayer = state.layers.find(l => l.id === item.id);
                            if (targetLayer) {
                                targetLayer.x = item.x;
                                targetLayer.y = item.y;
                                targetLayer.w = item.w;
                                targetLayer.h = item.h;
                            }
                        });
                    }
                    requestScreenRender();
                    debouncedSave();
                }
            };

            btnRedo.onclick = () => {
                if (state.cropMode) exitCropMode();
                if (state.redoStack.length > 0) {
                    const action = state.redoStack.pop();
                    if (action.type === "draw") {
                        state.history.push({
                            type: "draw",
                            data: drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)
                        });
                        drawCtx.putImageData(action.data, 0, 0);
                        drawLayerDirty = true;
                    } else if (action.type === "layer") {
                        const l = state.layers.find(item => item.id === action.layerId);
                        if (l) {
                            state.history.push({
                                type: "layer",
                                layerId: l.id,
                                data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height)
                            });
                            l.ctx.putImageData(action.data, 0, 0);
                            l._needsUpload = true;
                        }
                    } else if (action.type === "snapshot") {
                        state.history.push({ type: "snapshot", snap: captureLayerSnapshot() });
                        restoreLayerSnapshot(action.snap);
                        syncLayerPanelUI();
                    } else if (action.type === "canvas") {
                        state.history.push(action);
                        applyCanvasStateEntry(action.layerId, action.after);
                    } else if (action.type === "layout") {
                        state.history.push({
                            type: "layout",
                            layers: state.layers.map(l => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }))
                        });
                        action.layers.forEach(item => {
                            const targetLayer = state.layers.find(l => l.id === item.id);
                            if (targetLayer) {
                                targetLayer.x = item.x;
                                targetLayer.y = item.y;
                                targetLayer.w = item.w;
                                targetLayer.h = item.h;
                            }
                        });
                    }
                    requestScreenRender();
                    debouncedSave();
                }
            };

            btnClear.onclick = async () => {
                if (state.cropMode) exitCropMode();
                // 记录清空前的状态，使“清空画布”同样可撤销
                pushHistoryEntry({
                    type: "draw",
                    data: drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height)
                });
                pushLayerSnapshot();

                drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                drawLayerDirty = true;
                state.layers = [];
                state.selectedLayerIndex = -1;
                state.selectedLayerIndices = [];
                delete window._crazy3ds_memory_store[nodeInstance.id];
                if (nodeInstance.properties) {
                    nodeInstance.properties.layers = [];
                    nodeInstance.properties.has_draw = false;
                }
                requestScreenRender();
                try {
                    await api.fetchApi("/crazy3ds/clear_temp", { method: "POST" });
                } catch (e) {}
                debouncedSave();
            };

            const origOnResize = this.onResize;
            this.onResize = function (size) {
                origOnResize?.apply(this, arguments);
                applyHudFontScale();
                syncDisplayCanvasLayout();
                requestScreenRender();
            };

            this.addDOMWidget("crazy3ds_layout_compositor_ui", "compositor", root);

            setTimeout(() => {
                updateActiveColorUI();
                applyHudFontScale();
                restoreSavedData();
            }, 50);

            this.setSize([480, 560]);
        };
    }
});

const origQueuePrompt = app.queuePrompt;
app.queuePrompt = async function () {
    const nodes = app.graph?._nodes || [];
    for (const node of nodes) {
        if (node.type === "Crazy3DS_LayoutCompositor" && typeof node.forceBakeAndUpload === "function") {
            await node.forceBakeAndUpload();
        }
    }
    return origQueuePrompt.apply(this, arguments);
};
