"""Synthetic, public fixtures for #15. Run through npm run check's wrapper."""
import collections, io, json, struct, unittest, zipfile, zlib
import survey_corpus as s


def archive(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        for name, content in files.items():
            z.writestr(name, content)
    return b.getvalue()


class SurveyTest(unittest.TestCase):
    def test_nested_pack_and_resource_features(self):
        pack = archive({
            'pack.mcmeta': '{"pack":{"pack_format":71}}',
            'data/private/function/main.mcfunction': '# hi\nscoreboard players add x y \\\n 1\n',
            'data/private/function/empty.mcfunction': '# empty',
            'data/private/advancement/a.json': '{"criteria":{"private":{"trigger":"minecraft:tick"}},"rewards":{"function":"private:secret"}}',
            'data/private/predicate/p.json': '[{"condition":"minecraft:entity_properties"}]',
            'data/private/loot_table/l.json': '{"pools":[{"entries":[{"type":"minecraft:item","name":"private:secret"}]}]}',
        })
        outer = archive({'w/level.dat': b'unused', 'w/datapacks/private.zip': pack,
                         'resource/assets/private/font/secret.json': '{"providers":[{"type":"minecraft:bitmap"}]}'})
        count = collections.Counter(); rows = []
        with zipfile.ZipFile(io.BytesIO(outer)) as z:
            s.packs(z, 'w/datapacks/', 4325, rows.append, count, [0])
            s.resources(z, count)
        self.assertEqual(count['functions'], 2)
        self.assertEqual(count['empty_functions'], 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['cmd'], 'scoreboard players add x y 1')
        self.assertEqual(count['advancement.function_reward'], 1)
        self.assertEqual(count['predicate.condition.minecraft:entity_properties'], 1)
        self.assertEqual(count['loot_table.pools'], 1)
        self.assertEqual(count['resource_files.font'], 1)
        self.assertEqual(count['font.provider.bitmap'], 1)
        self.assertNotIn('secret', json.dumps(count))
        self.assertNotIn('private', json.dumps(count))

    def test_writes_keep_dynamic_and_function_context_unresolved(self):
        cb = {'dim':'overworld', 'pos':[1,2,3], 'cmd':'data modify block ~ ~ ~ Command set value "say hi"'}
        other = {'dim':'overworld', 'pos':[2,2,3], 'cmd':'say data modify block 1 2 3 Command set value "x"'}
        count = collections.Counter()
        s.writes([cb,other], ['execute positioned 1 2 3 run data merge block ~ ~ ~ {auto:1b}',
                              'data remove block 1 2 3 Command'], count)
        self.assertEqual(count['writes.data_block.lines'], 3)
        self.assertEqual(count['writes.data_block.self'], 1)
        self.assertEqual(count['writes.data_block.unresolved'], 2)

    def test_comparator_across_chunk_boundary_and_facing(self):
        # Minimal actual region/NBT bytes: comparator x=16 faces east, CB is x=15.
        def string(value):
            b = value.encode()
            return struct.pack('>H', len(b)) + b
        def named(kind, name, value):
            return bytes([kind]) + string(name) + value
        def compound(*tags):
            return b''.join(tags) + b'\0'
        def integer(name, value):
            return named(3, name, struct.pack('>i', value))
        air = compound(named(8, 'Name', string('minecraft:air')))
        comparator = compound(named(8, 'Name', string('minecraft:comparator')),
                              named(10, 'Properties', compound(named(8, 'facing', string('east')))))
        states = compound(named(9, 'palette', b'\x0a' + struct.pack('>i',2) + air + comparator),
                          named(12, 'data', struct.pack('>i',256) + struct.pack('>q',1) + b'\0' * (255*8)))
        section = compound(named(1, 'Y', b'\0'), named(10, 'block_states', states))
        raw = named(10, '', compound(integer('xPos',1), integer('zPos',0),
                    named(9, 'sections', b'\x0a' + struct.pack('>i',1) + section)))
        payload = zlib.compress(raw)
        region = bytearray(12288)
        region[4:8] = b'\0\0\x02\x01'  # chunk (1,0), sector 2
        region[8192:8197+len(payload)] = struct.pack('>i',len(payload)+1) + b'\x02' + payload
        count = collections.Counter()
        with zipfile.ZipFile(io.BytesIO(archive({'w/region/r.0.0.mca':region}))) as z:
            s.geometry(z, 'w/', [{'dim':'overworld','pos':[15,0,0]}], count)
        self.assertEqual(count['comparators'],1)
        self.assertEqual(count['comparators_adjacent_6_faces'],1)
        self.assertEqual(count['comparators_rear_input_command_block'],1)
        self.assertEqual(count['comparator_command_block_pairs'],1)

    def test_placement_overlap_includes_self_but_not_other_dimension(self):
        count = collections.Counter()
        s.writes([{'dim':'overworld','pos':[0,0,0], 'cmd':'fill ~ ~ ~ ~1 ~ ~ air'},
                  {'dim':'nether','pos':[1,0,0], 'cmd':''}], [], count)
        self.assertEqual(count['writes.direct_placement.overlaps_saved_cb.lines'],1)
        self.assertEqual(count['writes.direct_placement.overlaps_self.lines'],1)

    def test_fill_replacing_command_blocks_does_not_count_as_placing_them(self):
        count = collections.Counter()
        s.writes([], ['fill 0 0 0 1 1 1 air replace command_block',
                      'setblock 0 0 0 minecraft:command_block{Command:"say hi"}'], count)
        self.assertEqual(count['writes.place_command_block.lines'],1)
        self.assertEqual(count['writes.place_command_block.setblock'],1)

    def test_bad_json_counted_without_publishing_content(self):
        count = collections.Counter()
        with zipfile.ZipFile(io.BytesIO(archive({'x.json':'private invalid json'}))) as z:
            self.assertEqual(s.read_json(z, 'x.json', count), {})
        self.assertEqual(dict(count), {'invalid_json_files':1})


if __name__ == '__main__':
    unittest.main()
