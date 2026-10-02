// Message bodies as the RLC-1224A sends them: one tag per line, each line
// ending in "\n", so lengths equal the traces (reference/rlc-1224a/baichuan/).
// Templates after reolink_aio 5d37cb3 and PR #186 9a1bb52 (MIT, THIRD_PARTY_NOTICES).
import { LOGIN_REPLY_LINES } from './device-info';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" ?>';
export const doc = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
export const bodyXml = (inner: readonly string[]): string => doc([XML_DECL, '<body>', ...inner, '</body>']);
const extXml = (inner: readonly string[]): string => doc([XML_DECL, '<Extension version="1.1">', ...inner, '</Extension>']);

export function nonceXml(nonce: string): string {
  return bodyXml([
    '<Encryption version="1.1">', '<type>md5</type>', `<nonce>${nonce}</nonce>`, '<authTypeList>',
    '<authType>password</authType>', '<authType>sigV1</authType>', '<authType>authLogin</authType>', '<authType>getAccesskey</authType>',
    '</authTypeList>', '</Encryption>',
  ]);
}

// Measured: wrong credentials answer 401 with this body (the sim never locks).
export const LOGIN_ERR_XML = bodyXml(['<LoginErrInfo version="1.1">', '<remainTimes>10</remainTimes>', '</LoginErrInfo>']);
export const LINK_TYPE_XML = bodyXml(['<LinkType version="1.1">', '<type>LAN</type>', '</LinkType>']);

export const ENCRYPT_LEN = 1024;
export const EXT_BINARY = extXml(['<binaryData>1</binaryData>']);
export const EXT_CHUNK = extXml(['<binaryData>1</binaryData>', `<encryptLen>${ENCRYPT_LEN}</encryptLen>`]);

const SECRET_CODE = '<secretCode>REDACTED</secretCode>';
const BOOT_SECRET = '<bootSecret>REDACTED</bootSecret>';
export function loginReplyXml(secretCode: string, bootSecret: string): string {
  return doc(LOGIN_REPLY_LINES.map((l) => (l === SECRET_CODE ? `<secretCode>${secretCode}</secretCode>` : l === BOOT_SECRET ? `<bootSecret>${bootSecret}</bootSecret>` : l)));
}

// Measured (idle.txt): unsolicited after a login, message id 0, channel 0.
export interface PushMessage {
  cmd: number;
  afterMs: number; // after the login reply
  xml: string;
}
export const PUSHES: readonly PushMessage[] = [
  { cmd: 78, afterMs: 40, xml: bodyXml(['<VideoInput version="1.1">', '<channelId>0</channelId>', '<bright>128</bright>', '<contrast>128</contrast>', '<saturation>128</saturation>', '<hue>128</hue>', '</VideoInput>']) },
  { cmd: 79, afterMs: 40, xml: bodyXml(['<Serial version="1.1">', '<channelId>0</channelId>', '<baudRate>9600</baudRate>', '<dataBit>CS8</dataBit>', '<stopBit>1</stopBit>', '<parity>none</parity>', '<flowControl>none</flowControl>', '<controlProtocol>PELCO_D</controlProtocol>', '<controlAddress>1</controlAddress>', '</Serial>']) },
  { cmd: 464, afterMs: 300, xml: bodyXml(['<NetInfo version="1.1">', '<net_type>wire</net_type>', '<signal>100</signal>', '</NetInfo>']) },
  { cmd: 547, afterMs: 300, xml: bodyXml(['<SirenStatusList version="1.1" />']) },
  { cmd: 291, afterMs: 500, xml: bodyXml(['<FloodlightStatusList version="1.1">', '<FloodlightStatus>', '<channel>0</channel>', '<status>0</status>', '<brightness>100</brightness>', '</FloodlightStatus>', '</FloodlightStatusList>']) },
  { cmd: 677, afterMs: 500, xml: bodyXml(['<ioStatus version="1.1">', '<statusList>', '<channel>0</channel>', '</statusList>', '</ioStatus>']) },
  { cmd: 600, afterMs: 500, xml: bodyXml(['<yoloWorldEventList version="1.1" />']) },
  { cmd: 669, afterMs: 500, xml: bodyXml(['<AiModelList version="1.1">', '<AiModelItem>', '<name>clip</name>', '<version>1</version>', '</AiModelItem>', '</AiModelList>']) },
];

// Camera-local date and time, as the FileInfo XML and the info record carry it.
export interface Moment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const momentXml = (tag: string, m: Moment) => [
  `<${tag}>`, `<year>${m.year}</year>`, `<month>${m.month}</month>`, `<day>${m.day}</day>`,
  `<hour>${m.hour}</hour>`, `<minute>${m.minute}</minute>`, `<second>${m.second}</second>`, `</${tag}>`,
];

// cmd 13's reply (fileinfo.txt). handle is always 0 on the camera.
export function fileInfoXml(f: { name: string; size: number; start: Moment; end: Moment }): string {
  return bodyXml([
    '<FileInfoList version="1.1">', '<FileInfo>', '<channelId>0</channelId>', '<handle>0</handle>', `<name>${f.name}</name>`,
    '<containsAudio>1</containsAudio>', '<fileType>h264</fileType>', '<recordType>none</recordType>', '<supportSub>1</supportSub>',
    `<sizeL>${f.size % 2 ** 32}</sizeL>`, `<sizeH>${Math.floor(f.size / 2 ** 32)}</sizeH>`,
    ...momentXml('startTime', f.start), ...momentXml('endTime', f.end),
    '</FileInfo>', '</FileInfoList>',
  ]);
}

// The text of the first <tag>…</tag>; undefined when there is none.
export function tagValue(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const i = xml.indexOf(open);
  if (i < 0) return undefined;
  const j = xml.indexOf(`</${tag}>`, i + open.length);
  return j < 0 ? undefined : xml.slice(i + open.length, j);
}
