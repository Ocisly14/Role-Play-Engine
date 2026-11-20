import { useCallback, useEffect, useRef, useState } from "react";
import { GrayhavenWorld } from "./GrayhavenWorld";
import { formatTime, timeOfDay } from "./daylight";
import { loadGrayhavenArt } from "./painterlyArt";
import { locations, roadPaths, type Region } from "./layout";
import { allInteriorScenes, buildingForRoom, interiorBuilding, roomFloor, cleanSceneText, CLOSED_INTERIOR, type InteriorState } from './buildingInteriors';
import beachNotes from "./beachScene.generated.json";
import redwoodNotes from './redwoodRingScene.generated.json';
import "./grayhaven.css";

const regions: { id: Region; name: string }[] = [{ id: "town", name: "小镇" }, { id: "coast", name: "海岸" }, { id: "forest", name: "红杉林与山地" }];

export default function GrayhavenSandboxPage() {
  const host = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const world = useRef<GrayhavenWorld | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  const [hour, setHour] = useState(15);
  const hourRef = useRef(15);
  const [playing, setPlaying] = useState(false);
  const [fog, setFog] = useState(0.24);
  const [labels, setLabels] = useState(true);
  const [roads, setRoads] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [interior, setInterior] = useState<InteriorState>({...CLOSED_INTERIOR});
  const [expanded, setExpanded] = useState(false);
  const select = useCallback((id: string) => {
    setSelected(id); setExpanded(false); setIndexOpen(false); world.current?.select(id);
  }, []);
  const reset = useCallback(() => { setSelected(null); setIndexOpen(false); world.current?.reset(); }, []);

  useEffect(() => {
    document.title = "Grayhaven · 灰港镇";
    let instance: GrayhavenWorld | null = null;
    let cancelled = false;
    const started = performance.now();
    loadGrayhavenArt().then(art => {
      if (cancelled) { art.dispose(); return; }
      try {
        instance = new GrayhavenWorld(host.current!, labelHost.current!, {
          onSelect: select,
          initialHour: hourRef.current,
          onZoom: value => setZoom(Math.round(value * 100)),
          onError: setError,
          onInterior: setInterior,
          onTime: value => {hourRef.current=value;setHour(value);},
        }, art);
        host.current!.dataset.loadMs = String(Math.round(performance.now() - started));
        world.current = instance; setReady(true);
      } catch (cause) { art.dispose(); throw cause; }
    }).catch(cause => {
      if (cancelled) return;
      console.error("Grayhaven scene could not initialize", cause);
      host.current?.replaceChildren(); labelHost.current?.replaceChildren();
      setError("当前设备无法显示三维地图。你仍然可以通过地点目录阅读灰港镇。");
    });
    return () => { cancelled = true; instance?.dispose(); world.current = null; };
  }, [select]);

  useEffect(() => { world.current?.setAtmosphere(hourRef.current, fog); }, [ready, fog]);
  useEffect(() => { world.current?.setTimePlaying(playing); }, [ready, playing]);
  const scrubTime = (value:number) => {
    setPlaying(false);world.current?.setTimePlaying(false);
    hourRef.current=value;setHour(value);world.current?.setTime(value);
  };
  useEffect(() => { world.current?.setLabels(labels); }, [ready, labels]);
  useEffect(() => { world.current?.setRoads(roads); }, [ready, roads]);
  // Preserve selections made through the text directory while art is loading.
  useEffect(() => { world.current?.select(selected); }, [ready, selected]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === "+" || event.key === "=") world.current?.zoomBy(1.2);
      if (event.key === "-") world.current?.zoomBy(1 / 1.2);
      if (event.key === "0") reset();
      if (event.key === "Escape") { setIndexOpen(false); setSelected(null); world.current?.select(null, false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reset]);

  const building=interiorBuilding(interior);
  const room = allInteriorScenes.find(scene => scene.id === selected);
  const place = room ? {id:room.id,name:room.name,english:buildingForRoom(room.id)==='sheriff'?'SHERIFF / '+(room.id.endsWith('front')?'FRONT DESK':room.id.endsWith('office')?'OFFICE':'HOLDING CELL'):'BLUEBIRD DINER / '+(room.id.endsWith('upstairs')?'UPSTAIRS':room.id.endsWith('kitchen')?'KITCHEN':'DINING ROOM'),description:cleanSceneText(room.setting)} : locations.find(location => location.id === selected);
  useEffect(() => {
    if(interior.status!=='open' && selected!=='SCN_redwood_ring')return;
    const panel=host.current?.parentElement?.querySelector('.gh-place');
    const refit=()=>world.current?.fitSelectedDetail();
    const frame=requestAnimationFrame(refit);
    const observer=new ResizeObserver(refit);if(panel)observer.observe(panel);
    return()=>{cancelAnimationFrame(frame);observer.disconnect();};
  },[selected,interior.status]);
  const leaveRoom = () => {setSelected(null);world.current?.select(null,false);};
  const connections = place ? roadPaths.filter(road => road.from === place.id || road.to === place.id) : [];

  return <main className={`gh-sandbox${interior.status!=='closed'?' gh-has-interior':''}${selected==='SCN_redwood_ring'?' gh-has-outdoor-detail':''}`}>
    <div className="gh-canvas" ref={host} />
    <div className="gh-film" aria-hidden="true" />
    <div className="gh-labels" ref={labelHost} />
    <header className="gh-heading">
      <p className="gh-eyebrow">NORTHERN CALIFORNIA · 1985</p>
      <h1>Grayhaven<span>灰 港 镇</span></h1>
      <p className="gh-caption">海岸、旧街与红杉林之间</p>
    </header>
    <div className="gh-top-right">
      <span className="gh-preview">世界地图 <i /> 静态预览</span>
      <button className="gh-index-toggle" onClick={() => setIndexOpen(!indexOpen)} aria-expanded={indexOpen} aria-controls="gh-place-index">
        <span aria-hidden="true">☷</span> 地点目录 <small>{locations.length}</small>
      </button>
    </div>

    {indexOpen && <aside id="gh-place-index" className="gh-index gh-paper" aria-label="地点目录">
      <div className="gh-panel-title"><span>灰港镇 · 地点目录</span><button aria-label="关闭地点目录" onClick={() => setIndexOpen(false)}>×</button></div>
      {regions.map(region => <section key={region.id}>
        <h2>{region.name}</h2>
        {locations.filter(location => location.region === region.id).map(location => <button key={location.id} className="gh-place-row" onClick={() => select(location.id)}>
          <span>{location.name}<small>{location.english}</small></span><span aria-hidden="true">↗</span>
        </button>)}
      </section>)}
    </aside>}

    {interior.status !== 'closed' && <nav className="gh-interior-nav gh-paper" aria-label={building==='sheriff'?'警署房间与空间':'蓝鸟餐馆楼层与空间'}>
      <div className="gh-interior-title"><span>{building==='sheriff'?'SHERIFF / 警长办公室':'BLUEBIRD / 蓝鸟餐馆'}</span><small>{interior.status==='loading'?'正在展开室内…':interior.status==='error'?'室内暂未载入':'原地剖视 · 点击房间或物件阅读'}</small></div>
      {interior.status==='open' && <>
        <div className="gh-floor-buttons">{(building==='sheriff'?[0] as const:[0,1] as const).map(floor=><button key={floor} aria-pressed={interior.floor===floor} onClick={()=>{leaveRoom();world.current?.setInteriorFloor(floor);}}>{building==='sheriff'?'一层 · 警署':floor===0?'一层 · 餐馆':'二层 · 住处'}</button>)}</div>
        <div className="gh-room-buttons">{allInteriorScenes.filter(scene=>buildingForRoom(scene.id)===building && roomFloor(scene.id)===interior.floor).map(scene=><button key={scene.id} aria-pressed={interior.room===scene.id} onClick={()=>select(scene.id)}>{scene.name.split('·')[1]??scene.name}</button>)}</div>
        <button onClick={()=>{leaveRoom();world.current?.returnToBuilding();}}>看整层</button>
      </>}
      {interior.status==='error' && <button onClick={()=>world.current?.retryInterior()}>重试室内</button>}
      <button onClick={()=>{leaveRoom();world.current?.returnToStreet();}}>返回街道 ↗</button>
    </nav>}

    {place && <aside className="gh-place gh-paper" aria-label="地点说明" key={place.id}>
      <div className="gh-panel-title"><span>FIELD NOTES / 地点手记</span><button aria-label="关闭地点说明" onClick={() => { setSelected(null); world.current?.select(null, false); }}>×</button></div>
      <p className="gh-place-en">{place.english}</p><h2>{place.name}</h2>
      <p className={expanded ? "gh-description is-expanded" : "gh-description"}>{place.description}</p>
      <button className="gh-read-more" onClick={() => setExpanded(!expanded)}>{expanded ? "收起手记 −" : "阅读完整手记 +"}</button>
      {place.id === beachNotes.sceneId && <details className="gh-beach-notes">
        <summary>海滩细节 · {beachNotes.items.length} 处</summary>
        <p>继续放大，可看清码头上的渔具与潮线漂积物。</p>
        {beachNotes.items.map(item => <details key={item.id}>
          <summary>{item.name}</summary><p>{item.description}</p>
        </details>)}
      </details>}
      {place.id === redwoodNotes.sceneId && <details className="gh-beach-notes">
        <summary>林间细节 · {redwoodNotes.items.length} 处</summary>
        <p>继续放大，可看清树根旁的蘑菇、火塘和石缝里的铁皮罐。</p>
        {redwoodNotes.items.map(item => <details key={item.id}>
          <summary>{item.name}</summary><p>{item.description}</p>
        </details>)}
      </details>}
      {room && <>
        <details className="gh-beach-notes" open={!!interior.item}>
          <summary>房间物件 · {room.references.items.length} 处</summary>
          {room.references.items.map(item=><details key={item.id} open={interior.item===item.id || undefined}>
            <summary>{item.name}</summary><p>{item.description}</p>
          </details>)}
        </details>
        <div className="gh-connections"><h3>相连空间</h3>{room.references.connections.map(connection=><button key={connection.id} onClick={()=>{
          if(connection.targetId==='ROAD_main_street'){leaveRoom();world.current?.returnToStreet();}
          else select(connection.targetId);
        }} title={connection.description}>{connection.name}<small>↗</small></button>)}</div>
      </>}
      {connections.length > 0 && <div className="gh-connections"><h3>沿路前往 <span>模组步行时间</span></h3>
        {connections.map(road => {
          const next = locations.find(location => location.id === (road.from === place.id ? road.to : road.from))!;
          return <button key={road.id} onClick={() => select(next.id)} title={road.name}><span>{next.name}</span><small>{road.minutes} 分钟 ↗</small></button>;
        })}
      </div>}
    </aside>}

    {error ? <div className="gh-error gh-paper" role="alert"><p>{error}</p><button onClick={() => window.location.reload()}>重新载入</button><button onClick={() => setIndexOpen(true)}>查看地点</button></div>
      : !ready && <div className="gh-loading" role="status">正在展开灰港镇…</div>}

    <nav className="gh-map-controls" aria-label="地图操作">
      <button aria-label="放大地图" title="放大 (+)" onClick={() => world.current?.zoomBy(1.25)}>+</button>
      <button aria-label="缩小地图" title="缩小 (-)" onClick={() => world.current?.zoomBy(0.8)}>−</button>
      <button aria-label="回到全景" title="回到全景 (0)" onClick={reset}>⌖</button>
      <span />
      <button aria-label="地点标注" title="地点标注" aria-pressed={labels} onClick={() => setLabels(!labels)}>Aa</button>
      <button aria-label="道路指引" title="道路指引" aria-pressed={roads} onClick={() => setRoads(!roads)}>⌁</button>
    </nav>

    <footer className="gh-footer">
      <div className="gh-map-note"><span className="gh-note-line" /><p>16 处户外地点 · 19 条道路<small>地形为示意布局 · 拖动平移，滚轮缩放</small></p></div>
      <div className="gh-atmosphere" aria-label="画面氛围预览">
        <span className="gh-atmosphere-title">光与雾<small>一天的光景</small></span>
        <div className="gh-day-clock">
          <div className="gh-clock-heading"><output htmlFor="gh-daytime">{formatTime(hour)}</output><span>{timeOfDay(hour)}</span>
            <button className="gh-time-play" aria-label={playing?'暂停时间':'播放一天光照变化'} aria-pressed={playing} title="播放速度：4 分钟走过一天；拖动时间轴自动暂停" onClick={()=>setPlaying(!playing)}>{playing?'Ⅱ 暂停':'▷ 播放'}</button>
          </div>
          <input id="gh-daytime" aria-label="地图时间" aria-valuetext={`${formatTime(hour)}，${timeOfDay(hour)}`} type="range" min="0" max="1439" step="1" value={Math.floor(hour*60+1e-7)} onChange={event=>scrubTime(Number(event.target.value)/60)} />
          <div className="gh-time-ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        </div>
        <label className="gh-fog">海雾 <input aria-label="海雾浓度" type="range" min="0" max="1" step="0.01" value={fog} onChange={event => setFog(Number(event.target.value))} /><output>{Math.round(fog * 100)}%</output></label>
      </div>
      <div className="gh-compass" aria-label={`缩放 ${zoom}%`}><span aria-hidden="true">N<br />↑</span><small>{zoom}%</small></div>
    </footer>
  </main>;
}
