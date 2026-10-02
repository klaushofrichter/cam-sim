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

// Unsolicited pushes, message id 0, channel 0, as measured in
// reference/rlc-1224a/baichuan/idle.txt (first experiment, session A):
//   afterLogin:      cmds 78 and 79 come 0.30 s after the login reply, 464 and 547 0.40 s after it.
//   beforeIdleClose: cmds 291, 677, 600 and 669 come once, as the camera closes an idle session
//                    (32 s after the client's last message). The server sends them delayMs before
//                    its own idle close (config idle timeout minus delayMs), so shortened test
//                    timeouts stay consistent. The camera sent them within milliseconds of the
//                    close; 500 ms is the sim's margin so the client reads them first.
//   afterLinkType:   in the second experiment the same group came LATE_AFTER_LINK_TYPE_MS after a
//                    client's first message after login (cmd 93 from A; B sent cmd 4000 and got
//                    the group too, so the trigger may be any client message). Once per session.
// Not mirrored: the second 78/79/464/547 round about 1 s after login (idle.txt, second
// experiment). The trace interleaves two sessions, so which one it belongs to is not reliable.
export type PushTrigger = 'afterLogin' | 'beforeIdleClose' | 'afterLinkType';
export interface PushMessage {
  cmd: number;
  trigger: PushTrigger;
  delayMs: number; // after the login reply / after the cmd 93 / before the idle close
  xml: string;
}
export const LATE_AFTER_LINK_TYPE_MS = 3;
const afterLogin = (cmd: number, delayMs: number, inner: readonly string[]): PushMessage => ({ cmd, trigger: 'afterLogin', delayMs, xml: bodyXml(inner) });
const late = (cmd: number, inner: readonly string[]): PushMessage => ({ cmd, trigger: 'beforeIdleClose', delayMs: 500, xml: bodyXml(inner) });
export const PUSHES: readonly PushMessage[] = [
  afterLogin(78, 300, ['<VideoInput version="1.1">', '<channelId>0</channelId>', '<bright>128</bright>', '<contrast>128</contrast>', '<saturation>128</saturation>', '<hue>128</hue>', '</VideoInput>']),
  afterLogin(79, 300, ['<Serial version="1.1">', '<channelId>0</channelId>', '<baudRate>9600</baudRate>', '<dataBit>CS8</dataBit>', '<stopBit>1</stopBit>', '<parity>none</parity>', '<flowControl>none</flowControl>', '<controlProtocol>PELCO_D</controlProtocol>', '<controlAddress>1</controlAddress>', '</Serial>']),
  afterLogin(464, 400, ['<NetInfo version="1.1">', '<net_type>wire</net_type>', '<signal>100</signal>', '</NetInfo>']),
  afterLogin(547, 400, ['<SirenStatusList version="1.1" />']),
  late(291, ['<FloodlightStatusList version="1.1">', '<FloodlightStatus>', '<channel>0</channel>', '<status>0</status>', '<brightness>100</brightness>', '</FloodlightStatus>', '</FloodlightStatusList>']),
  late(677, ['<ioStatus version="1.1">', '<statusList>', '<channel>0</channel>', '</statusList>', '</ioStatus>']),
  late(600, ['<yoloWorldEventList version="1.1" />']),
  late(669, ['<AiModelList version="1.1">', '<AiModelItem>', '<name>clip</name>', '<version>1</version>', '</AiModelItem>', '</AiModelList>']),
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
