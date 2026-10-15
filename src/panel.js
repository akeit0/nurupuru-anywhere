import styles from './panel.css';

export function createPanel() {
  const host = document.createElement('div');host.id = 'nurupuru-anywhere';
  for (const [key, value] of Object.entries({ all: 'initial', position: 'absolute', left: '0', top: '0', width: '0', height: '0', 'z-index': '2147483647', 'pointer-events': 'none' })) host.style.setProperty(key, value, 'important');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${styles}</style><canvas id="canvas"></canvas><div id="highlight"></div><div id="hit" hidden></div>
    <section id="panel" aria-label="Nurupuru Anywhere">
      <header><strong>ぬるぷる <small>Anywhere</small></strong><span id="status" role="status" aria-live="polite"></span><button id="fold" aria-expanded="true" aria-controls="detail">畳む</button><button id="close" title="画像を元に戻して、拡張の操作を閉じる">閉じる</button></header>
      <div class="image-controls"><button id="select"><span id="selectLabel">画像を選ぶ</span><small id="selectHint"></small></button><button id="enabled" aria-pressed="true" title="効果を一時停止">ON</button><button id="release" title="選択中の画像の効果と塗りを解除する" hidden>画像を解除</button></div>
      <div id="detail">
      <fieldset id="editing" hidden>
      <div class="tool-labels"><span>動かすところを塗る</span><span>つかんで揺らす</span></div>
      <div id="tools" role="group" aria-label="ツール"><button data-tool="brush" aria-pressed="true">塗る <small>B</small></button><button data-tool="erase" aria-pressed="false">消す <small>E</small></button><button data-tool="grab" aria-pressed="false">つかむ <small>G</small></button></div>
      <div id="brush">
        <label>サイズ <input id="size" type="range" min="8" max="240" value="68"><output id="sizeValue">68 px</output></label>
        <label id="strengthRow">動きやすさ <input id="strength" type="range" min="0" max="255" value="255"><output id="strengthValue">255</output></label>
        <div class="actions"><button id="fill">全体を塗る</button><button id="clear">塗りを消去</button></div>
      </div>
      <div id="grab"><span>塗った部分をドラッグして離す</span><button id="reset">揺れを戻す</button></div>
      <details id="material"><summary>材質</summary>
        <div class="presets" role="group" aria-label="材質プリセット"><button data-material="rubber">硬め</button><button data-material="jelly" aria-pressed="true">標準</button><button data-material="soft">やわらかめ</button></div>
        <label>やわらかさ <input id="softness" type="range" min="0" max="100" value="35"><output id="softnessValue">35</output></label>
        <label>戻る速さ <input id="returnSpeed" type="range" min="0" max="100" value="48"><output id="returnSpeedValue">48</output></label>
        <label>減衰 <input id="damping" type="range" min="0" max="100" value="32"><output id="dampingValue">32</output></label>
      </details>
      </fieldset>
      </div></section>`;
  document.documentElement.append(host);
  const $ = id => root.getElementById(id), canvas = $('canvas'), hit = $('hit'), highlight = $('highlight');
  return { host, root, $, canvas, hit, highlight };
}
