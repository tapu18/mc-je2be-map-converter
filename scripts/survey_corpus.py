#!/usr/bin/env python3
"""Read-only #15 survey. JSON aggregates to stdout; private command JSONL to --commands.
Never publish the scratch JSONL. Input archives are opened read-only, never extracted.
"""
import argparse, collections, gzip, io, json, re, sys, zipfile
from contextlib import ExitStack
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_command_blocks as ex
from dump_commands import function_lines, pack_format
from scan_command_blocks import NBT
from command_patterns import tokenize


def read_json(z, name, count):
    try:
        return json.loads(z.read(name).decode('utf-8-sig'))
    except (ValueError, UnicodeError):
        count['invalid_json_files'] += 1
        return {}


def resources(z, count):
    for name in z.namelist():
        m = re.search(r'(?:^|/)assets/[^/]+/(models|font|shaders|textures|sounds|items)/', name)
        if m and not name.endswith('/'):
            count['resource_files.' + m[1]] += 1
        if re.search(r'(?:^|/)assets/[^/]+/font/.*\.json$', name):
            obj = read_json(z, name, count)
            for provider in obj.get('providers', []):
                kind = provider.get('type', '')
                kind = kind[10:] if isinstance(kind, str) and kind.startswith('minecraft:') else kind
                count['font.provider.' + (kind if kind in ('bitmap','space','ttf','unihex','reference') else '<other>')] += 1
        if re.search(r'(?:^|/)assets/[^/]+/sounds.json$', name):
            count['resource_files.sounds.json'] += 1
        if re.search(r'(?:^|/)assets/[^/]+/models/.*\.json$', name):
            obj = read_json(z, name, count)
            for override in obj.get('overrides', []):
                if 'custom_model_data' in override.get('predicate', {}):
                    count['model_custom_model_data_overrides'] += 1
        if re.search(r'(?:^|/)assets/[^/]+/items/.*\.json$', name):
            obj = read_json(z, name, count)
            count['item_model_definitions'] += 1
            walk_json(obj, count, 'item_model')


def walk_json(obj, count, category):
    # Only a fixed vocabulary is published. Custom IDs and all values are discarded.
    allowed = {
        'trigger': {'minecraft:tick', 'minecraft:impossible', 'minecraft:inventory_changed',
                    'minecraft:using_item', 'minecraft:consume_item', 'minecraft:player_killed_entity',
                    'minecraft:entity_hurt_player', 'minecraft:location', 'minecraft:recipe_unlocked'},
        'condition': {'minecraft:reference', 'minecraft:entity_properties', 'minecraft:location_check',
                      'minecraft:random_chance', 'minecraft:value_check', 'minecraft:inverted',
                      'minecraft:all_of', 'minecraft:any_of', 'minecraft:match_tool'},
        'type': {'minecraft:item', 'minecraft:loot_table', 'minecraft:alternatives', 'minecraft:empty',
                 'minecraft:select', 'minecraft:range_dispatch', 'minecraft:condition', 'minecraft:model'},
        'property': {'minecraft:custom_model_data', 'minecraft:component', 'minecraft:using_item'},
    }
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in allowed and isinstance(value, str):
                normalized = value if ':' in value else 'minecraft:' + value
                count[f'{category}.{key}.' + (normalized if normalized in allowed[key] else '<other>')] += 1
            if key == 'function' and category == 'advancement' and isinstance(value, str):
                count['advancement.function_reward'] += 1
            walk_json(value, count, category)
    elif isinstance(obj, list):
        for value in obj:
            walk_json(value, count, category)


def writes(cbs, lines, count):
    positions = {(c['dim'], *c['pos']) for c in cbs}
    for cmd, origin in [(c['cmd'], c) for c in cbs] + [(l, None) for l in lines]:
        tokens = tokenize(cmd.strip().lstrip('/').lstrip('$'))
        # Inspect actual command positions, not text arguments containing command keywords.
        starts = [0]
        while starts[-1] < len(tokens) and tokens[starts[-1]] in ('execute', 'return'):
            try:
                starts.append(tokens.index('run', starts[-1] + 1) + 1)
            except ValueError:
                break
        start = starts[-1]
        ts = tokens[start:]
        if len(ts) < 3:
            continue
        if ts[0] in ('setblock', 'fill') and len(ts) > {'setblock':4, 'fill':7}[ts[0]] and re.match(r'(?:minecraft:)?(?:chain_|repeating_)?command_block(?:[\[{]|$)', ts[{'setblock':4, 'fill':7}[ts[0]]]):
            count['writes.place_command_block.lines'] += 1
            count['writes.place_command_block.' + ts[0]] += 1
            count['writes.place_command_block.' + ('cb' if origin else 'fn')] += 1
        if origin and not start and ts[0] in ('setblock', 'fill', 'clone'):
            n = {'setblock':3, 'fill':6, 'clone':9}[ts[0]]
            coords = ts[1:1+n]
            if len(coords) == n and all(re.fullmatch(r'-?\d+|~(?:-?\d+)?', t) for t in coords):
                xyz = [origin['pos'][i % 3] + int(t[1:] or 0) if t.startswith('~') else int(t) for i,t in enumerate(coords)]
                a, b = xyz[:3], xyz[:3] if n == 3 else xyz[3:6]
                lo = [min(a[i], b[i]) for i in range(3)]; hi = [max(a[i], b[i]) for i in range(3)]
                if ts[0] == 'clone':
                    lo, hi = xyz[6:9], [xyz[6+i] + hi[i] - lo[i] for i in range(3)]
                hits = [p for p in positions if p[0] == origin['dim'] and all(lo[i] <= p[i+1] <= hi[i] for i in range(3))]
                if hits:
                    count['writes.direct_placement.overlaps_saved_cb.lines'] += 1
                    if any(list(p[1:]) == origin['pos'] for p in hits):
                        count['writes.direct_placement.overlaps_self.lines'] += 1
        if ts[0] != 'data' or ts[1] not in ('merge','modify','remove') or ts[2] != 'block':
            continue
        count['writes.data_block.lines'] += 1
        if len(ts) > 6 and (re.match(r'(?:Command|auto|SuccessCount|TrackOutput|LastOutput)(?:[.\[{]|$)', ts[6]) or
                           (ts[1] == 'merge' and re.search(r'(?:^|[,\{])\s*(?:Command|auto|SuccessCount|TrackOutput|LastOutput)\s*:', ts[6]))):
            count['writes.explicit_command_block_nbt.lines'] += 1
        if len(ts) < 7:
            continue
        # Absolute coordinates in direct commands are resolvable even in functions.
        # Execute contexts may change dimension/position; conservatively leave those unresolved.
        if start or any(not re.fullmatch(r'-?\d+|~(?:-?\d+)?', t) for t in ts[3:6]) or (origin is None and any(t.startswith('~') for t in ts[3:6])):
            count['writes.data_block.unresolved'] += 1
            continue
        coords = [origin['pos'][i] + int(t[1:] or 0) if t.startswith('~') else int(t) for i,t in enumerate(ts[3:6])]
        # Functions have no fixed dimension, so cannot prove which saved block is targeted.
        if origin is None:
            count['writes.data_block.unresolved'] += 1
            continue
        if (origin['dim'], *coords) in positions:
            count['writes.data_block.saved_command_block'] += 1
            if coords == origin['pos']:
                count['writes.data_block.self'] += 1
        else:
            count['writes.data_block.other_saved_position'] += 1


def geometry(z, base, cbs, count):
    commands = {(c['dim'], *c['pos']) for c in cbs}
    comparators = {}
    for name in z.namelist():
        if not name.startswith(base) or not name.endswith('.mca'):
            continue
        rel = name[len(base):]
        if 'region/' not in rel:
            continue
        dim = rel.rsplit('region/', 1)[0].rstrip('/') or 'overworld'
        region = z.read(name)
        for idx in range(1024):
            off = int.from_bytes(region[idx*4:idx*4+3], 'big') * 4096
            if off and region[off+4] not in (1, 2, 3):
                raise ValueError('Unsupported region compression or external chunk')
        for raw in ex.iter_chunks(region):
            if b'comparator' not in raw:
                continue
            root = NBT(raw).root(); root = root.get('Level', root)
            for sec in root.get('sections', root.get('Sections', [])):
                bs = sec.get('block_states', {})
                pal = bs.get('palette', sec.get('Palette', []))
                if not any(ex.normalize_state(p)[0] == 'minecraft:comparator' for p in pal):
                    continue
                for j in range(4096):
                    x, y, zz = j % 16, j // 256, (j // 16) % 16
                    nm, props = ex.normalize_state(ex.block_at(sec, x, y, zz))
                    if nm == 'minecraft:comparator':
                        comparators[(dim, root['xPos'] * 16 + x, sec['Y'] * 16 + y, root['zPos'] * 16 + zz)] = props.get('facing')
    offsets = [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]
    # JE facing points toward the input (verified by corpus-survey.servers.test.ts).
    rear = {'east':(1,0,0), 'west':(-1,0,0), 'north':(0,0,-1), 'south':(0,0,1)}
    adjacent = set(); pairs = 0
    for pos, facing in comparators.items():
        dim,x,y,zz = pos
        for dx,dy,dz in offsets:
            if (dim,x+dx,y+dy,zz+dz) in commands:
                adjacent.add(pos); pairs += 1
        if facing in rear:
            dx,dy,dz = rear[facing]
            if (dim,x+dx,y+dy,zz+dz) in commands:
                count['comparators_rear_input_command_block'] += 1
    count['comparators'] += len(comparators)
    count['comparators_adjacent_6_faces'] += len(adjacent)
    count['comparator_command_block_pairs'] += pairs


def packs(z, prefix, dv, emit, count, next_fn, emit_definition=None):
    names = z.namelist()
    for name in names:
        if not name.startswith(prefix):
            continue
        rel = name[len(prefix):]
        if name.endswith('.mcfunction'):
            pack = prefix + rel.split('/', 1)[0] + '/' if prefix.endswith('datapacks/') else prefix
            rows = function_lines(z.read(name).decode('utf-8-sig'))
            fid = next_fn[0]; next_fn[0] += 1
            count['functions'] += 1
            if not rows:
                count['empty_functions'] += 1
            for cmd in rows:
                emit({'source':'fn', 'function':fid, 'cmd':cmd, 'dataVersion':dv, 'packFormat':pack_format(z, pack)})
            count['function_lines'] += len(rows)
        m = re.search(r'/data/[^/]+/(advancements?|predicates?|loot_tables?)/.*\.json$', '/' + name)
        if m:
            category = {'advancement':'advancement','advancements':'advancement', 'predicate':'predicate',
                        'predicates':'predicate','loot_table':'loot_table','loot_tables':'loot_table'}[m[1]]
            count[category + '.files'] += 1
            obj = read_json(z, name, count)
            if emit_definition is not None:
                emit_definition(category, obj)
            walk_json(obj, count, category)
            if category == 'loot_table' and isinstance(obj, dict):
                count['loot_table.pools'] += len(obj.get('pools', []))
        if prefix and name.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(z.read(name))) as child:
                packs(child, '', dv, emit, count, next_fn, emit_definition)


def scan(z, emit, count, next_fn, emit_definition=None):
    resources(z, count)
    names = z.namelist()
    levels = [n for n in names if n == 'level.dat' or n.endswith('/level.dat')]
    for lv in levels:
        base = lv[:-len('level.dat')]
        count['worlds'] += 1
        cbs = ex.command_blocks(z, base)
        count['command_blocks'] += len(cbs)
        geometry(z, base, cbs, count)
        dv = NBT(gzip.decompress(z.read(lv))).root().get('Data', {}).get('DataVersion')
        world_rows = []
        def world_emit(row):
            world_rows.append(row)
            emit(row)
        for c in cbs:
            if c['cmd'].strip():
                emit({'source':'cb', 'cmd':c['cmd'], 'dataVersion':dv, 'packFormat':None})
                count['nonempty_command_blocks'] += 1
        packs(z, base + 'datapacks/', dv, world_emit, count, next_fn, emit_definition)
        writes(cbs, [r['cmd'] for r in world_rows], count)
    if not levels and 'pack.mcmeta' in names and any(n.startswith('data/') for n in names):
        count['datapack_only'] += 1
        rows = []
        def pack_emit(row):
            rows.append(row)
            emit(row)
        packs(z, '', None, pack_emit, count, next_fn, emit_definition)
        writes([], [r['cmd'] for r in rows], count)
        return
    # Recurse all embedded ZIPs for resource packs, but do not double-count world datapacks.
    for name in names:
        if name.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(z.read(name))) as child:
                if any(name.startswith(lv[:-len('level.dat')] + 'datapacks/') for lv in levels):
                    resources(child, count)
                else:
                    scan(child, emit, count, next_fn, emit_definition)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input', type=Path)
    ap.add_argument('--commands', required=True, type=Path)
    ap.add_argument('--definitions', type=Path, help='private datapack JSONL for the compatibility ledger')
    args = ap.parse_args()
    paths = sorted(args.input.glob('*.zip')) if args.input.is_dir() else [args.input]
    if not paths:
        ap.error('No input archives')
    count = collections.Counter(archives=len(paths)); fid = [0]
    # Fail closed: no swallowed archive/NBT/JSON errors, no exception text with private data.
    try:
        with ExitStack() as files:
            output = files.enter_context(args.commands.open('x', encoding='utf-8'))
            definitions = files.enter_context(args.definitions.open('x', encoding='utf-8')) if args.definitions else None
            for i, path in enumerate(paths):
                def emit(row):
                    output.write(json.dumps({'map':i, **row}, ensure_ascii=False) + '\n')
                def emit_definition(category, obj):
                    definitions.write(json.dumps({'map':i, 'category':category, 'definition':obj}, ensure_ascii=False) + '\n')
                with zipfile.ZipFile(path) as z:
                    scan(z, emit, count, fid, emit_definition if definitions is not None else None)
    except Exception:
        raise SystemExit('Survey failed; inspect inputs locally. No complete aggregate was produced.') from None
    print(json.dumps(dict(sorted(count.items())), indent=2))

if __name__ == '__main__':
    main()
