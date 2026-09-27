import type { Engine } from '../engine/engine';
import type { Trigger } from '../engine/types';
import { esc } from './soap';

// The RLC-1224A's ONVIF event topics and message shapes (captured from the
// real camera on 2026-09-27: GetEventProperties and the Initialized messages
// of a PullPoint subscription).
interface Topic {
  topic: string;
  source: Array<[string, string]>;
  data: string; // IsMotion or State
}

const RULE_SOURCE: Array<[string, string]> = [['VideoSourceConfigurationToken', '000'], ['VideoAnalyticsConfigurationToken', '000'], ['Rule', '000']];
const SRC: Array<[string, string]> = [['Source', '000']];

export const TOPICS: Topic[] = [
  { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', source: RULE_SOURCE, data: 'IsMotion' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/FaceDetect', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/PeopleDetect', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/VehicleDetect', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/Non_Motor_VehicleDetect', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/DogCatDetect', source: SRC, data: 'State' },
  { topic: 'tns1:VideoSource/MotionAlarm', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/Visitor', source: SRC, data: 'State' },
  { topic: 'tns1:RuleEngine/MyRuleDetector/Package', source: SRC, data: 'State' },
];

// Which topics a simulated detection drives. Motion drives both motion topics.
const FOR_TRIGGER: Record<Trigger, string[]> = {
  motion: ['tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:VideoSource/MotionAlarm'],
  person: ['tns1:RuleEngine/MyRuleDetector/PeopleDetect'],
  vehicle: ['tns1:RuleEngine/MyRuleDetector/VehicleDetect'],
  pet: ['tns1:RuleEngine/MyRuleDetector/DogCatDetect'],
};

export const topicsFor = (t: Trigger) => FOR_TRIGGER[t] ?? [];

const utc = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');

export function notification(topicName: string, state: boolean, op: 'Initialized' | 'Changed', at = new Date()): string {
  const t = TOPICS.find((x) => x.topic === topicName)!;
  const source = t.source.map(([n, v]) => `<tt:SimpleItem Name="${n}" Value="${esc(v)}" />`).join('');
  return `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${t.topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${utc(at)}" PropertyOperation="${op}"><tt:Source>${source}</tt:Source><tt:Data><tt:SimpleItem Name="${t.data}" Value="${state}" /></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
}

// The current state of a topic, from the engine's detection state.
export function currentState(engine: Engine, topicName: string): boolean {
  const md = engine.events.mdState().state === 1;
  const ai = engine.events.aiState();
  switch (topicName) {
    case 'tns1:RuleEngine/CellMotionDetector/Motion':
    case 'tns1:VideoSource/MotionAlarm':
      return md;
    case 'tns1:RuleEngine/MyRuleDetector/PeopleDetect':
      return ai.people.alarm_state === 1;
    case 'tns1:RuleEngine/MyRuleDetector/VehicleDetect':
      return ai.vehicle.alarm_state === 1;
    case 'tns1:RuleEngine/MyRuleDetector/DogCatDetect':
      return ai.dog_cat.alarm_state === 1;
    default:
      return false;
  }
}

// GetEventProperties: the camera's topic set (as captured).
export const EVENT_PROPERTIES = `<tev:GetEventPropertiesResponse><tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation><wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet><tns1:VideoSource wstop:topic="false"><MotionAlarm wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="Source" Type="tt:ReferenceToken"/></tt:Source><tt:Data><tt:SimpleItemDescription Name="State" Type="xsd:boolean"/></tt:Data></tt:MessageDescription></MotionAlarm><ImageTooDark wstop:topic="false"><ImagingService wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="Source" Type="tt:ReferenceToken" /></tt:Source><tt:Data><tt:SimpleItemDescription Name="State" Type="xsd:boolean" /></tt:Data></tt:MessageDescription></ImagingService></ImageTooDark></tns1:VideoSource><tns1:Media wstop:topic="false"><ProfileChanged wstop:topic="true"><tt:MessageDescription IsProperty="false"><tt:Data><tt:SimpleItemDescription Name="Token" Type="tt:ReferenceToken" /></tt:Data></tt:MessageDescription></ProfileChanged><ConfigurationChanged wstop:topic="true"><tt:MessageDescription IsProperty="false"><tt:Source><tt:SimpleItemDescription Name="Token" Type="tt:ReferenceToken" /></tt:Source><tt:Data><tt:SimpleItemDescription Name="Type" Type="xsd:string" /></tt:Data></tt:MessageDescription></ConfigurationChanged></tns1:Media><tns1:RuleEngine wstop:topic="true"><CellMotionDetector wstop:topic="true"><Motion wstop:topic="true"><tt:MessageDescription IsProperty="true"><tt:Source><tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/><tt:SimpleItemDescription Name="VideoAnalyticsConfigurationToken" Type="tt:ReferenceToken"/><tt:SimpleItemDescription Name="Rule" Type="xsd:string"/></tt:Source><tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xsd:boolean"/></tt:Data></tt:MessageDescription></Motion></CellMotionDetector></tns1:RuleEngine></wstop:TopicSet><wsnt:TopicExpressionDialect>http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet</wsnt:TopicExpressionDialect><wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete</wsnt:TopicExpressionDialect><tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect><tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation></tev:GetEventPropertiesResponse>`;
