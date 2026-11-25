import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import org.iq80.leveldb.Options;
import org.iq80.leveldb.impl.Iq80DBFactory;

// Read the raw overworld subchunk records with the LevelDB implementation bundled in Chunker.
class DumpSubchunks {
    public static void main(String[] args) throws Exception {
        Path output = Files.createDirectory(Path.of(args[1]));
        try (var db = Iq80DBFactory.factory.open(Path.of(args[0]).toFile(), new Options().createIfMissing(false));
             var entries = db.iterator()) {
            for (entries.seekToFirst(); entries.hasNext();) {
                var entry = entries.next();
                byte[] key = entry.getKey();
                if (key.length != 10 || key[8] != 0x2f) {
                    continue;
                }
                var coordinates = ByteBuffer.wrap(key).order(ByteOrder.LITTLE_ENDIAN);
                int x = coordinates.getInt();
                int z = coordinates.getInt();
                Files.write(output.resolve(x + "." + z + "." + key[9]), entry.getValue());
            }
        }
    }
}
