/*
  Ping

  Turns an LED on for one second, then off for one second, repeatedly.

  Also prints pong to the serial monitor when ping is received.

  Some boards may interfere with the serial detectability when printing
  so this sketch only prints when ping is received.

*/

// the setup function runs once when you press reset or power the board
void setup() {
  // initialize digital pin LED_BUILTIN as an output.
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.setTimeout(500);
}

// read the serial port for ping, and respond with pong
void pingCheck() {
  if (!Serial.available()) {
    return;
  }
  String input = Serial.readStringUntil('\n');
  input.trim();
  if (input == "ping") {
    delay(100);
    Serial.println("pong {{key}}");
  }
}

// the loop function runs over and over again forever
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);   // turn the LED on (HIGH is the voltage level)
  pingCheck();
  delay(500);                       // wait for half a second
  digitalWrite(LED_BUILTIN, LOW);    // turn the LED off by making the voltage LOW
  pingCheck();
  delay(500);                       // wait for half a second
}