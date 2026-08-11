/**
 * @description Pure Apex ZIP Archive Builder (PKZip 2.0 Store format).
 * Assembles valid ZIP files with local file headers, central directory, and CRC32 in pure Apex.
 */
public with sharing class AgentforceZipBuilder {

    private List<ZipEntry> entries = new List<ZipEntry>();

    public class ZipEntry {
        public String filename;
        public Blob data;
        public Integer uncompressedSize;
        public Long crc32;
        public Integer offset;
    }

    public AgentforceZipBuilder() {
    }

    /**
     * @description Add a text file into the ZIP archive.
     */
    public void addTextFile(String filename, String textContent) {
        Blob data = Blob.valueOf(textContent != null ? textContent : '');
        addBinaryFile(filename, data);
    }

    /**
     * @description Add a binary Blob file (PDF, PNG, JSON, etc.) into the ZIP archive.
     */
    public void addBinaryFile(String filename, Blob data) {
        if (String.isBlank(filename) || data == null) {
            return;
        }
        ZipEntry entry = new ZipEntry();
        entry.filename = filename.replace('\\', '/');
        entry.data = data;
        entry.uncompressedSize = data.size();
        entry.crc32 = computeCrc32(data);
        entries.add(entry);
    }

    /**
     * @description Assembles and returns the complete binary ZIP Blob.
     */
    public Blob getZipArchive() {
        String hexLocalFiles = '';
        String hexCentralDirectory = '';
        Integer currentOffset = 0;
        Integer numEntries = entries.size();

        for (ZipEntry entry : entries) {
            entry.offset = currentOffset;
            Blob nameBlob = Blob.valueOf(entry.filename);
            Integer nameLen = nameBlob.size();
            Integer dataLen = entry.uncompressedSize;

            // Local File Header (30 bytes + nameLen + dataLen)
            String localHeader = '504b0304';                      // Signature (0x04034b50)
            localHeader += '0a00';                               // Version needed (1.0)
            localHeader += '0000';                               // General purpose bit flag
            localHeader += '0000';                               // Compression method (0 = Stored)
            localHeader += '00000000';                           // File last mod time & date
            localHeader += toHex32(entry.crc32);                 // CRC-32
            localHeader += toHex32(dataLen);                     // Compressed size
            localHeader += toHex32(dataLen);                     // Uncompressed size
            localHeader += toHex16(nameLen);                     // Filename length
            localHeader += '0000';                               // Extra field length
            localHeader += EncodingUtil.convertToHex(nameBlob);   // Filename
            localHeader += EncodingUtil.convertToHex(entry.data); // File Data

            hexLocalFiles += localHeader;
            currentOffset += (30 + nameLen + dataLen);

            // Central Directory File Header (46 bytes + nameLen)
            String cdHeader = '504b0102';                        // Signature (0x02014b50)
            cdHeader += '1400';                                  // Version made by (2.0)
            cdHeader += '0a00';                                  // Version needed (1.0)
            cdHeader += '0000';                                  // General purpose bit flag
            cdHeader += '0000';                                  // Compression method (0 = Stored)
            cdHeader += '00000000';                             // File last mod time & date
            cdHeader += toHex32(entry.crc32);                   // CRC-32
            cdHeader += toHex32(dataLen);                       // Compressed size
            cdHeader += toHex32(dataLen);                       // Uncompressed size
            cdHeader += toHex16(nameLen);                       // Filename length
            cdHeader += '0000';                                 // Extra field length
            cdHeader += '0000';                                 // File comment length
            cdHeader += '0000';                                 // Disk number start
            cdHeader += '0000';                                 // Internal file attributes
            cdHeader += '00000000';                             // External file attributes
            cdHeader += toHex32(entry.offset);                  // Relative offset of local header
            cdHeader += EncodingUtil.convertToHex(nameBlob);    // Filename

            hexCentralDirectory += cdHeader;
        }

        Integer cdSize = hexCentralDirectory.length() / 2;
        Integer cdOffset = currentOffset;

        // End of Central Directory Record (22 bytes)
        String eocd = '504b0506';                                // Signature (0x06054b50)
        eocd += '0000';                                          // Number of this disk
        eocd += '0000';                                          // Disk where central directory starts
        eocd += toHex16(numEntries);                             // Total entries on this disk
        eocd += toHex16(numEntries);                             // Total entries in central directory
        eocd += toHex32(cdSize);                                 // Size of central directory
        eocd += toHex32(cdOffset);                               // Offset of start of central directory
        eocd += '0000';                                          // Comment length

        String completeHex = hexLocalFiles + hexCentralDirectory + eocd;
        return EncodingUtil.convertFromHex(completeHex);
    }

    // =========================================================================
    // HELPER METHODS (HEX CONVERSIONS & CRC-32)
    // =========================================================================

    private static String toHex16(Integer val) {
        Integer b0 = val & 255;
        Integer b1 = (val >> 8) & 255;
        return byteToHex(b0) + byteToHex(b1);
    }

    private static String toHex32(Long val) {
        Integer b0 = (Integer) (val & 255);
        Integer b1 = (Integer) ((val >> 8) & 255);
        Integer b2 = (Integer) ((val >> 16) & 255);
        Integer b3 = (Integer) ((val >> 24) & 255);
        return byteToHex(b0) + byteToHex(b1) + byteToHex(b2) + byteToHex(b3);
    }

    private static String byteToHex(Integer b) {
        String hexChars = '0123456789abcdef';
        Integer hi = (b >> 4) & 15;
        Integer lo = b & 15;
        return hexChars.substring(hi, hi + 1) + hexChars.substring(lo, lo + 1);
    }

    private static List<Long> crcTable;
    private static void initCrcTable() {
        if (crcTable != null) return;
        crcTable = new List<Long>();
        for (Integer i = 0; i < 256; i++) {
            Long c = i;
            for (Integer j = 0; j < 8; j++) {
                if ((c & 1) != 0) {
                    c = 3988292384L ^ (c >> 1); // 0xEDB88320
                } else {
                    c = c >> 1;
                }
            }
            crcTable.add(c);
        }
    }

    public static Long computeCrc32(Blob data) {
        initCrcTable();
        String hex = EncodingUtil.convertToHex(data);
        Integer len = hex.length() / 2;
        Long crc = 4294967295L; // 0xFFFFFFFF
        String hexChars = '0123456789abcdef';

        for (Integer i = 0; i < len; i++) {
            String bHex = hex.substring(i * 2, i * 2 + 2);
            Integer hi = hexChars.indexOf(bHex.substring(0, 1));
            Integer lo = hexChars.indexOf(bHex.substring(1, 2));
            Integer b = (hi << 4) | lo;
            Integer tableIndex = (Integer) ((crc ^ b) & 255);
            crc = crcTable[tableIndex] ^ (crc >> 8);
        }
        return (crc ^ 4294967295L) & 4294967295L;
    }
}
