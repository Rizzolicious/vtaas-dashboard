/* VT&AAS real hardware firmware
   Reads MPU6050 + NMEA GPS, drives status LEDs/buzzer, sends incident SMS via SIM800L,
   and publishes real (never simulated) JSON telemetry through the authenticated WSS relay.
   Prototype only: tune and validate impact thresholds on a secured test rig before any use.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <time.h>
#include <math.h>
#include "relay_ca.h"
#if __has_include("config.h")
  #include "config.h"
#else
  #include "config.example.h"
#endif

static const uint8_t MPU_ADDR = 0x68;
static const int PIN_SDA=21, PIN_SCL=22, PIN_GPS_RX=16, PIN_GPS_TX=17;
static const int PIN_SIM_RX=27, PIN_SIM_TX=26, PIN_LED_RED=4, PIN_LED_GREEN=18, PIN_BUZZER=19;
static const float G0=9.80665f, IMPACT_G=2.7f;
static const uint32_t COUNTDOWN_MS=15000, EVENT_COOLDOWN_MS=30000;
HardwareSerial gpsUart(1), simUart(2);
WebSocketsClient relay;

struct Fix { bool valid=false; double lat=NAN, lon=NAN, speed=NAN, hdop=NAN; uint32_t sats=0, at=0; };
Fix gps;
char nmea[128]; size_t nmeaLen=0;
float accel[3]={NAN,NAN,NAN}, gyro[3]={NAN,NAN,NAN}, baseA[3]={0,0,0}, baseG[3]={0,0,0};
bool mpuFound=false, imuCalibrated=false, auth=false, relayStarted=false;
uint32_t bootId=0, seqNo=0, lastTelemetry=0, lastProbe=0, impactAt=0, eventCounter=0, cooldownUntil=0;
uint32_t calibrationSamples=0; double calA[3]={0,0,0}, calG[3]={0,0,0};
int accidentPhase=0; // 0 normal, 1 countdown, 2 cancelled, 3 confirmed, 4 manual SOS
char eventId[64]=""; const char *severity="NONE", *messageType="telemetry";
float crashSpeed=NAN, estimatedDecel=NAN; uint32_t alarmUntil=0;
SemaphoreHandle_t statusMutex; QueueHandle_t smsQueue;
char gsmStatus[32]="NOT_CHECKED", smsStatus[64]="NOT_REQUESTED";
struct SmsJob { char id[64]; char severity[16]; bool hasSpeed, hasFix; float speed; double lat,lon; };

static void copyStatus(char *gsm, size_t gn, char *sms, size_t sn) {
  xSemaphoreTake(statusMutex, portMAX_DELAY); strlcpy(gsm,gsmStatus,gn); strlcpy(sms,smsStatus,sn); xSemaphoreGive(statusMutex);
}
static void setStatus(const char *gsm, const char *sms) {
  xSemaphoreTake(statusMutex, portMAX_DELAY);
  if(gsm) strlcpy(gsmStatus,gsm,sizeof(gsmStatus));
  if(sms) strlcpy(smsStatus,sms,sizeof(smsStatus));
  xSemaphoreGive(statusMutex);
}
static bool writeMpu(uint8_t reg,uint8_t value){ Wire.beginTransmission(MPU_ADDR); Wire.write(reg); Wire.write(value); return Wire.endTransmission()==0; }
static bool readMpu(uint8_t reg,uint8_t *out,size_t n){
  Wire.beginTransmission(MPU_ADDR); Wire.write(reg); if(Wire.endTransmission(false)!=0) return false;
  if(Wire.requestFrom((int)MPU_ADDR,(int)n,(int)true)!=(int)n) return false;
  for(size_t i=0;i<n;i++) out[i]=Wire.read(); return true;
}
static bool probeMpu(){ uint8_t id=0; if(!readMpu(0x75,&id,1)) return false; return (id&0x7E)==0x68; }
static bool initMpu(){ if(!writeMpu(0x6B,0x01)) return false; delay(30); writeMpu(0x1A,0x03); writeMpu(0x19,0x09); writeMpu(0x1B,0x18); writeMpu(0x1C,0x18); return true; }
static bool readImu(){
  uint8_t b[14]; if(!readMpu(0x3B,b,14)) return false;
  int16_t ax=(int16_t)((b[0]<<8)|b[1]), ay=(int16_t)((b[2]<<8)|b[3]), az=(int16_t)((b[4]<<8)|b[5]);
  int16_t gx=(int16_t)((b[8]<<8)|b[9]), gy=(int16_t)((b[10]<<8)|b[11]), gz=(int16_t)((b[12]<<8)|b[13]);
  accel[0]=ax/2048.0f*G0; accel[1]=ay/2048.0f*G0; accel[2]=az/2048.0f*G0;
  gyro[0]=gx/16.4f; gyro[1]=gy/16.4f; gyro[2]=gz/16.4f; return true;
}
static double parseCoord(const char *v,const char *hem){ if(!v||!hem||!*v) return NAN; double raw=atof(v); int deg=(int)(raw/100.0); double val=deg+(raw-deg*100.0)/60.0; if(*hem=='S'||*hem=='W') val=-val; return val; }
static void processNmea(char *line){
  if(line[0]!='$') return; char *star=strchr(line,'*'); if(!star||strlen(star)<3) return;
  uint8_t sum=0; for(char*p=line+1;p<star;p++) sum^=(uint8_t)*p;
  char *end=nullptr; long supplied=strtol(star+1,&end,16); if(end==star+1||sum!=(uint8_t)supplied) return;
  *star='\0'; char *f[20]={}; int n=0; char *save=nullptr; for(char*p=strtok_r(line,",",&save);p&&n<20;p=strtok_r(nullptr,",",&save)) f[n++]=p;
  if(n<2) return; const char *kind=f[0]+(strlen(f[0])>=3?strlen(f[0])-3:0);
  uint32_t now=millis();
  if(strcmp(kind,"RMC")==0 && n>=9){
    bool ok=f[2][0]=='A'; double lat=parseCoord(f[3],f[4]),lon=parseCoord(f[5],f[6]);
    gps.valid=ok&&isfinite(lat)&&isfinite(lon); if(gps.valid){gps.lat=lat;gps.lon=lon;gps.speed=f[7][0]?atof(f[7])*1.852:NAN;gps.at=now;}
    else {gps.speed=NAN; gps.at=now;}
  } else if(strcmp(kind,"GGA")==0 && n>=10){ gps.sats=(uint32_t)atoi(f[7]); gps.hdop=f[8][0]?atof(f[8]):NAN; if(atoi(f[6])==0){gps.valid=false;gps.speed=NAN;} }
}
static void pollGps(){ while(gpsUart.available()){ char c=(char)gpsUart.read(); if(c=='\n'){nmea[nmeaLen]='\0';processNmea(nmea);nmeaLen=0;} else if(c!='\r'){if(nmeaLen<sizeof(nmea)-1)nmea[nmeaLen++]=c;else nmeaLen=0;} } if(gps.valid&&millis()-gps.at>3000){gps.valid=false;gps.speed=NAN;} }
static float gpsSpeed(){ return gps.valid&&isfinite(gps.speed)?(float)gps.speed:NAN; }
static void setIncident(int phase,const char *kind){
  accidentPhase=phase; messageType=kind; eventCounter++;
  snprintf(eventId,sizeof(eventId),"%08lx-%lu",(unsigned long)bootId,(unsigned long)eventCounter);
  float sp=gpsSpeed(); crashSpeed=isfinite(sp)?sp:NAN;
  // Estimate longitudinal deceleration only when X is mounted along the vehicle direction.
  estimatedDecel=imuCalibrated?fmaxf(0.0f,-(accel[0]-baseA[0])):NAN;
  float impact=0; if(imuCalibrated) for(int i=0;i<3;i++){float d=accel[i]-baseA[i];impact+=d*d;} impact=sqrtf(impact)/G0;
  severity=impact>=5.0f?"SEVERE":impact>=3.5f?"MODERATE":"WARNING";
  if(phase==4) severity="EMERGENCY";
  if(phase==1) impactAt=millis(); else alarmUntil=millis()+30000;
  char sms[64]; snprintf(sms,sizeof(sms),phase==1?"PENDING_COUNTDOWN":"PENDING_SOS"); setStatus(nullptr,sms);
}
static void enqueueSms(){
  SmsJob j={}; strlcpy(j.id,eventId,sizeof(j.id)); strlcpy(j.severity,severity,sizeof(j.severity));
  float sp=gpsSpeed(); j.hasSpeed=isfinite(crashSpeed); j.speed=crashSpeed; j.hasFix=gps.valid; j.lat=gps.lat; j.lon=gps.lon;
  if(xQueueSend(smsQueue,&j,0)!=pdTRUE) setStatus(nullptr,"FAILED_QUEUE_FULL");
}
static bool readReply(const char *needle,uint32_t timeout,bool prompt=false){
  uint32_t start=millis(); String response;
  while(millis()-start<timeout){ while(simUart.available()){ char c=(char)simUart.read(); if(prompt&&c=='>') return true; response+=c; if(needle&&*needle&&response.indexOf(needle)>=0)return true; if(response.indexOf("ERROR")>=0)return false; if(response.length()>500)response.remove(0,250);} vTaskDelay(pdMS_TO_TICKS(10)); }
  return false;
}
static bool at(const char*cmd,const char*expect,uint32_t timeout=2500){ while(simUart.available())simUart.read(); simUart.println(cmd); return readReply(expect,timeout); }
static bool modemRegistered(){
  if(!at("AT","OK")&&!at("AT","OK")) return false; at("ATE0","OK"); at("AT+CMEE=2","OK");
  if(!at("AT+CPIN?","READY",3000)) return false;
  uint32_t start=millis(); bool registered=false;
  while(millis()-start<45000){ while(simUart.available())simUart.read(); simUart.println("AT+CREG?");
    uint32_t t=millis(); String r; while(millis()-t<1500){while(simUart.available())r+=(char)simUart.read(); if(r.indexOf("+CREG: 0,1")>=0||r.indexOf("+CREG: 0,5")>=0){registered=true;break;} vTaskDelay(pdMS_TO_TICKS(10));} if(registered)break; vTaskDelay(pdMS_TO_TICKS(1500)); }
  return registered;
}
static void smsWorker(void*){
  SmsJob j;
  for(;;){ if(xQueueReceive(smsQueue,&j,portMAX_DELAY)!=pdTRUE)continue;
    setStatus("CHECKING_MODEM","SENDING");
    if(!modemRegistered()){setStatus("NOT_REGISTERED_OR_NO_SIM","FAILED_MODEM_NOT_READY");continue;}
    at("AT+CMGF=1","OK"); at("AT+CSCS=\"GSM\"","OK");
    char cmd[48]; snprintf(cmd,sizeof(cmd),"AT+CMGS=\"%s\"",SMS_RECIPIENT);
    while(simUart.available())simUart.read(); simUart.println(cmd);
    if(!readReply("",10000,true)){setStatus("REGISTERED","FAILED_NO_SMS_PROMPT");continue;}
    char body[380];
    if(j.hasFix&&j.hasSpeed) snprintf(body,sizeof(body),"VT&AAS %s event %s. GPS %.6f,%.6f https://maps.google.com/?q=%.6f,%.6f. Speed %.1f km/h.",j.severity,j.id,j.lat,j.lon,j.lat,j.lon,j.speed);
    else if(j.hasFix) snprintf(body,sizeof(body),"VT&AAS %s event %s. GPS %.6f,%.6f https://maps.google.com/?q=%.6f,%.6f. Speed unavailable.",j.severity,j.id,j.lat,j.lon,j.lat,j.lon);
    else if(j.hasSpeed) snprintf(body,sizeof(body),"VT&AAS %s event %s. GPS fix unavailable. Speed %.1f km/h.",j.severity,j.id,j.speed);
    else snprintf(body,sizeof(body),"VT&AAS %s event %s. GPS fix and speed unavailable.",j.severity,j.id);
    simUart.print(body); simUart.write((uint8_t)26);
    bool cmgs=readReply("+CMGS:",60000); bool ok=cmgs&&readReply("OK",5000);
    if(ok)setStatus("REGISTERED","SUBMITTED_NOT_DELIVERY_CONFIRMED");
    else setStatus("REGISTERED","SUBMISSION_UNCONFIRMED_NO_AUTO_RETRY");
  }
}
static void sensorTask(void*){
  uint32_t lastProbe=0,lastSample=0,stationaryAt=millis(); int impactSamples=0; bool wasActive=false;
  for(;;){ uint32_t now=millis(); pollGps();
    if(!mpuFound&&now-lastProbe>=2000){lastProbe=now;mpuFound=probeMpu()&&initMpu(); if(mpuFound){imuCalibrated=false;calibrationSamples=0;stationaryAt=now;}}
    if(mpuFound&&now-lastSample>=10){lastSample=now;
      if(!readImu()){mpuFound=false;imuCalibrated=false;continue;}
      if(!imuCalibrated){ if(now-stationaryAt>5000){stationaryAt=now;calibrationSamples=0;memset(calA,0,sizeof(calA));memset(calG,0,sizeof(calG));}
        for(int i=0;i<3;i++){calA[i]+=accel[i];calG[i]+=gyro[i];} calibrationSamples++;
        if(calibrationSamples>=200){for(int i=0;i<3;i++){baseA[i]=calA[i]/calibrationSamples;baseG[i]=calG[i]/calibrationSamples;} imuCalibrated=true;Serial.println("MPU6050 baseline captured; impact detection armed.");}
      } else if(accidentPhase==0&&now>=cooldownUntil){
        float d2=0;for(int i=0;i<3;i++){float d=accel[i]-baseA[i];d2+=d*d;}float deltaG=sqrtf(d2)/G0;
        impactSamples=deltaG>=IMPACT_G?impactSamples+1:0;
        if(impactSamples>=2){impactSamples=0;setIncident(1,"accident_countdown");Serial.println("Impact threshold reached. 15-second cancellation window started.");}
      }
    }
    if(accidentPhase==1&&now-impactAt>=COUNTDOWN_MS){accidentPhase=3;messageType="accident_confirmed";alarmUntil=now+30000;enqueueSms();Serial.println("Countdown expired; incident confirmed and SMS queued once.");}
    if(accidentPhase==2&&now-impactAt>=5000){accidentPhase=0;messageType="telemetry";cooldownUntil=now+EVENT_COOLDOWN_MS;}
    if((accidentPhase==3||accidentPhase==4)&&now>=alarmUntil){accidentPhase=0;messageType="telemetry";cooldownUntil=now+EVENT_COOLDOWN_MS;}
    bool alarm=(accidentPhase==1||((accidentPhase==3||accidentPhase==4)&&now<alarmUntil));
    digitalWrite(PIN_LED_RED,alarm||(!mpuFound&&((now/500)%2==0))?HIGH:LOW);
    digitalWrite(PIN_LED_GREEN,mpuFound&&imuCalibrated&&!alarm?HIGH:LOW);
    digitalWrite(PIN_BUZZER,alarm&&((now/250)%2==0)?HIGH:LOW);
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}
static void onRelay(WStype_t type,uint8_t *payload,size_t len){
  if(type==WStype_CONNECTED){auth=false;JsonDocument d;d["type"]="auth";d["role"]="device";d["token"]=DEVICE_WS_TOKEN;String s;serializeJson(d,s);relay.sendTXT(s);Serial.println("TLS relay connected; authenticating.");}
  else if(type==WStype_DISCONNECTED){auth=false;Serial.println("Relay disconnected; reconnecting.");}
  else if(type==WStype_TEXT){JsonDocument d;if(deserializeJson(d,payload,len))return;
    if(strcmp(d["type"]|"","auth_ok")==0){auth=true;Serial.println("Relay authenticated; real sensor telemetry enabled.");}
    else if(strcmp(d["type"]|"","error")==0){auth=false;Serial.println("Relay rejected authentication. Check local config token.");relay.disconnect();}
    if(auth&&strcmp(d["message_type"]|"","benchmark_ping")==0){const char*id=d["probe_id"]|"";const char*client=d["probe_client"]|"";if(strlen(id)<100&&strlen(client)<100){JsonDocument p;p["message_type"]="benchmark_pong";p["probe_id"]=id;p["probe_client"]=client;String out;serializeJson(p,out);relay.sendTXT(out);}}
  } else if(type==WStype_ERROR) Serial.println("Relay TLS/socket error; certificate verification remains enabled.");
}
static void sendTelemetry(){
  time_t epoch=time(nullptr); char timestamp[25]=""; if(epoch>1704067200){struct tm t;gmtime_r(&epoch,&t);strftime(timestamp,sizeof(timestamp),"%Y-%m-%dT%H:%M:%SZ",&t);}
  char gsm[32],sms[64];copyStatus(gsm,sizeof(gsm),sms,sizeof(sms)); JsonDocument d;
  d["device_id"]="vehicle_01";d["device_name"]="VT&AAS ESP32 real hardware";d["vehicle_name"]="VT&AAS vehicle 01";
  d["message_type"]=messageType;d["simulation"]=false;d["test_mode"]=false;d["transport"]="websocket";if(timestamp[0])d["timestamp"]=timestamp;
  d["vehicle_status"]=(gps.valid&&gps.speed>80.0)?"OVERSPEED":(mpuFound?"NORMAL":"SENSOR_ERROR");d["sensor_status"]=mpuFound&&imuCalibrated?"OK":"IMU_UNAVAILABLE_OR_CALIBRATING";
  const char*states[]={"NONE","COUNTDOWN","CANCELLED","CONFIRMED","SOS"};d["accident_state"]=states[accidentPhase];d["severity"]=severity;
  d["sequence"]=++seqNo;d["boot_id"]=bootId;d["uptime_ms"]=millis();d["wifi_rssi_dbm"]=WiFi.RSSI();d["speed_limit_kmh"]=80;
  float sp=gpsSpeed();if(isfinite(sp))d["speed_kmh"]=sp;else d["speed_kmh"]=nullptr;
  uint32_t elapsed=millis()-impactAt;
  d["countdown_remaining_s"]=accidentPhase==1?(elapsed>=COUNTDOWN_MS?0:(COUNTDOWN_MS-elapsed+999)/1000):0;
  if(eventId[0]&&accidentPhase!=0)d["event_id"]=eventId;
  if(isfinite(crashSpeed)&&eventId[0])d["crash_speed_kmh"]=crashSpeed;else d["crash_speed_kmh"]=nullptr;
  if(isfinite(estimatedDecel)&&eventId[0])d["deceleration_mps2"]=estimatedDecel;else d["deceleration_mps2"]=nullptr;
  d["deceleration_source"]="MPU6050 X-axis estimate; orient X along vehicle forward";d["sms_status"]=sms;d["gsm_status"]=gsm;d["gps_source"]="NEO-6M NMEA";d["imu_source"]="MPU6050 measured";
  JsonObject g=d["gps"].to<JsonObject>();g["valid"]=gps.valid;if(gps.valid){g["latitude"]=gps.lat;g["longitude"]=gps.lon;if(isfinite(sp))g["speed_kmh"]=sp;else g["speed_kmh"]=nullptr;g["satellites"]=gps.sats;if(isfinite(gps.hdop))g["hdop"]=gps.hdop;else g["hdop"]=nullptr;}else{g["latitude"]=nullptr;g["longitude"]=nullptr;g["speed_kmh"]=nullptr;g["satellites"]=gps.sats;g["hdop"]=nullptr;}
  const char*axes[]={"x","y","z"};JsonObject a=d["acceleration"].to<JsonObject>(),r=d["gyroscope"].to<JsonObject>();for(int i=0;i<3;i++){if(mpuFound){a[axes[i]]=accel[i];r[axes[i]]=gyro[i];}else{a[axes[i]]=nullptr;r[axes[i]]=nullptr;}}a["unit"]="m/s2";r["unit"]="deg/s";
  d["battery_percent"]=nullptr;d["battery_v"]=nullptr;String frame;serializeJson(d,frame);if(relay.sendTXT(frame))Serial.printf("Real telemetry #%lu | GPS %s | IMU %s | %s\n",(unsigned long)seqNo,gps.valid?"fix":"no fix",mpuFound?"read":"missing",states[accidentPhase]);
}
static void handleSerial(){static String line;while(Serial.available()){char c=(char)Serial.read();if(c=='\r'||c=='\n'){line.trim();if(line.equalsIgnoreCase("CANCEL")&&accidentPhase==1){accidentPhase=2;messageType="accident_cancelled";severity="NONE";setStatus(nullptr,"CANCELLED_NOT_SENT");digitalWrite(PIN_BUZZER,LOW);Serial.println("Countdown cancelled; no SMS was sent.");}else if(line.equalsIgnoreCase("SOS")&&accidentPhase==0){setIncident(4,"manual_sos");enqueueSms();Serial.println("Manual SOS sent to modem queue.");}else if(line.equalsIgnoreCase("STATUS")){Serial.printf("WiFi %s | relay %s | MPU %s | GPS %s | GSM %s\n",WiFi.status()==WL_CONNECTED?"connected":"waiting",auth?"authenticated":"offline",mpuFound?"present":"missing",gps.valid?"fix":"no fix",gsmStatus);}line="";}else if(line.length()<40)line+=c;}}
void setup(){
  Serial.begin(115200);delay(500);Serial.println("VT&AAS real hardware firmware starting. No sensor readings are simulated.");
  pinMode(PIN_LED_RED,OUTPUT);pinMode(PIN_LED_GREEN,OUTPUT);pinMode(PIN_BUZZER,OUTPUT);digitalWrite(PIN_BUZZER,LOW);
  statusMutex=xSemaphoreCreateMutex();smsQueue=xQueueCreate(3,sizeof(SmsJob));
  Wire.begin(PIN_SDA,PIN_SCL);Wire.setTimeOut(20);gpsUart.begin(9600,SERIAL_8N1,PIN_GPS_RX,PIN_GPS_TX);simUart.begin(9600,SERIAL_8N1,PIN_SIM_RX,PIN_SIM_TX);
  bootId=esp_random();xTaskCreatePinnedToCore(sensorTask,"sensors",8192,nullptr,2,nullptr,1);xTaskCreatePinnedToCore(smsWorker,"sms",8192,nullptr,1,nullptr,0);
  WiFi.persistent(false);WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);configTime(0,0,"time.cloudflare.com","pool.ntp.org");
  relay.onEvent(onRelay);relay.setReconnectInterval(5000);
  Serial.println("Pins: MPU SDA21/SCL22; GPS RX16/TX17; SIM RX27/TX26; LEDs4/18; buzzer19.");
  Serial.println("Serial commands: STATUS, CANCEL (during countdown), SOS (manual emergency test).");
}
void loop(){
  handleSerial();uint32_t now=millis();
  if(WiFi.status()!=WL_CONNECTED){auth=false;if(now-lastProbe>5000){lastProbe=now;WiFi.reconnect();Serial.println("Waiting for hotspot Wi-Fi.");}delay(5);return;}
  if(time(nullptr)<1704067200){if(now-lastProbe>5000){lastProbe=now;Serial.println("Wi-Fi connected; waiting for network time for TLS certificate validation.");}delay(5);return;}
  if(!relayStarted){relay.beginSslWithCA("vtaas-ws-relay.rizzoliciouss.workers.dev",443,"/ws",RELAY_ROOT_CA,"");relay.setExtraHeaders("");relay.enableHeartbeat(15000,3000,2);relayStarted=true;Serial.println("Opening certificate-validated WebSocket relay.");}
  relay.loop();if(auth&&now-lastTelemetry>=1000){lastTelemetry=now;sendTelemetry();}delay(1);
}
